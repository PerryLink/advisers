#!/usr/bin/env node
/**
 * Portable bundle ZIP codec and verifier (0.4.0 offline/portable channel).
 *
 * Why a hand-written ZIP writer instead of `zip`/`tar.exe`/a dependency:
 * - the release artifact must be byte-for-byte reproducible from the same input
 *   tree on Windows and on Linux (portable release builds may run on either;
 *   the payload itself is assembled on Windows because of native optional
 *   dependencies, but the container format must not depend on the host tooling);
 * - CI and release machines must not need an external archiver;
 * - the verifier must be able to re-read every entry, check its CRC-32, reject
 *   unsafe names (absolute paths, drive letters, `..`) and compare the whole
 *   file SHA-256 with the published `SHA256SUMS` line.
 *
 * No new dependencies: deflate comes from node:zlib (raw deflate, stored inside
 * the zip container), CRC-32 is implemented here, fixed DOS timestamps make the
 * archive deterministic (1980-01-01, the earliest representable DOS date).
 *
 * Importable as a library (pure functions, JSON-ready results, no I/O in the
 * exported helpers except the explicit file helpers) or run as a CLI:
 *
 *   node scripts/portable-zip.mjs                       # self-test (no args)
 *   node scripts/portable-zip.mjs --self-test
 *   node scripts/portable-zip.mjs --build <dir> --out <zip> [--prefix <name>]
 *   node scripts/portable-zip.mjs --verify <zip> [--sha256 <hex> | --sidecar]
 *   node scripts/portable-zip.mjs --list <zip>
 *   node scripts/portable-zip.mjs --extract <zip> --dest <dir>
 *
 * A production archive is built by `scripts/pack-portable.mjs`, which assembles
 * the portable directory (licenses, launcher, node-runtime notes, package.json)
 * and then calls `zipDirectory` from this module.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LAYOUT_FORMAT = 1
/** Fixed DOS date/time: 1980-01-01 00:00:00 (the ZIP epoch). */
export const FIXED_DOS_TIME = 0
export const FIXED_DOS_DATE = 0x21
/** Node.js floor for the product; also written into the bundle README. */
export const NODE_FLOOR = '22.16'
export const LICENSE_ID = 'PolyForm-Noncommercial-1.0.0'

const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const UTF8_FLAG = 0x0800
const METHOD_DEFLATE = 8
const METHOD_STORE = 0
const VERSION_NEEDED = 20
const VERSION_MADE_BY = (3 << 8) | 20 // UNIX, spec 2.0 (external mode bits are honoured by unzip/tar on POSIX)
const FILE_MODE = 0o644
const MAX_ENTRIES = 0xffff
const MAX_UINT32 = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value
  }
  return table
})()

/** Standard CRC-32 (IEEE 802.3), the checksum the ZIP format stores per entry. */
export function crc32(data) {
  let value = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** SHA-256 hex digest of a Buffer/string. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 hex digest of a file. */
export function sha256File(file) {
  return sha256(readFileSync(file))
}

/**
 * JSON-ready byte count, used for PASS lines and the README/size report.
 * Kept decimal-only so the output is stable across locales.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return value.toFixed(1) + ' ' + units[unit]
}

function toPosixPath(value) {
  return String(value).split('\\').join('/')
}

/**
 * Reject names that must never be extracted: absolute paths, drive letters,
 * UNC paths and any `..` segment. The ZIP writer never produces these, so a hit
 * means the file is corrupt or hostile.
 */
export function safeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name.includes('\u0000')) return false
  const posix = toPosixPath(name)
  if (posix.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(posix)) return false
  if (posix.split('/').some((segment) => segment === '..')) return false
  return true
}

/**
 * Recursively list files under `root` as POSIX-style relative paths, sorted
 * bytewise. Directories are implied; no entry is emitted for them, which keeps
 * the archive small and deterministic.
 */
export function listBundleFiles(root, options = {}) {
  const base = resolve(root)
  const files = []
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile()) {
        files.push(relative(base, absolute).split(sep).join('/'))
      } else if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) {
          // A portable bundle must be self-contained; refuse symlinks instead of
          // silently following them (the payload itself is copied with dereference).
          throw new Error('refusing to package a symlink: ' + absolute)
        }
        // npm creates node_modules/.bin/* symlinks when the payload is assembled
        // on a POSIX host; store the target file content instead. Anything that
        // escapes the bundle or points at a directory is still refused.
        let real
        try {
          real = realpathSync(absolute)
        } catch {
          throw new Error('refusing to package a broken symlink: ' + absolute)
        }
        const linkRel = relative(base, real)
        if (!linkRel || linkRel === '..' || linkRel.startsWith('..' + sep) || isAbsolute(linkRel)) throw new Error('refusing to package a symlink that escapes the bundle: ' + absolute)
        if (!statSync(real).isFile()) throw new Error('refusing to package a symlinked directory: ' + absolute)
        files.push(relative(base, absolute).split(sep).join('/'))
      }
    }
  }
  walk(root)
  return files.sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0))
}

/**
 * Build a deterministic ZIP buffer from a directory tree.
 * @returns {Buffer}
 */
export function zipDirectory(root, options = {}) {
  const base = resolve(root)
  const prefix = toPosixPath(options.prefix || '').replace(/^\/+|\/+$/g, '')
  const files = listBundleFiles(base, { followSymlinks: Boolean(options.followSymlinks) })
  if (files.length > MAX_ENTRIES) throw new Error('portable bundle has ' + files.length + ' files; the ZIP writer supports at most ' + MAX_ENTRIES)
  const chunks = []
  const central = []
  let offset = 0
  for (const relativePath of files) {
    const name = prefix ? prefix + '/' + relativePath : relativePath
    if (!safeEntryName(name)) throw new Error('unsafe ZIP entry name: ' + name)
    const data = readFileSync(join(base, ...relativePath.split('/')))
    if (data.length > MAX_UINT32) throw new Error('file too large for a non-ZIP64 archive: ' + relativePath)
    const compressed = deflateRawSync(data, { level: 9 })
    const useStore = compressed.length >= data.length
    const method = useStore ? METHOD_STORE : METHOD_DEFLATE
    const payload = useStore ? data : compressed
    const nameBuffer = Buffer.from(name, 'utf8')
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(FIXED_DOS_TIME, 10)
    local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuffer, payload)

    const directoryEntry = Buffer.alloc(46)
    directoryEntry.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0)
    directoryEntry.writeUInt16LE(VERSION_MADE_BY, 4)
    directoryEntry.writeUInt16LE(VERSION_NEEDED, 6)
    directoryEntry.writeUInt16LE(UTF8_FLAG, 8)
    directoryEntry.writeUInt16LE(method, 10)
    directoryEntry.writeUInt16LE(FIXED_DOS_TIME, 12)
    directoryEntry.writeUInt16LE(FIXED_DOS_DATE, 14)
    directoryEntry.writeUInt32LE(checksum, 16)
    directoryEntry.writeUInt32LE(payload.length, 20)
    directoryEntry.writeUInt32LE(data.length, 24)
    directoryEntry.writeUInt16LE(nameBuffer.length, 28)
    directoryEntry.writeUInt16LE(0, 30) // extra length
    directoryEntry.writeUInt16LE(0, 32) // comment length
    directoryEntry.writeUInt16LE(0, 34) // disk number start
    directoryEntry.writeUInt16LE(0, 36) // internal attributes
    directoryEntry.writeUInt32LE((FILE_MODE << 16) >>> 0, 38) // external attributes (POSIX mode)
    directoryEntry.writeUInt32LE(offset, 42)
    central.push(directoryEntry, nameBuffer)

    offset += local.length + nameBuffer.length + payload.length
    if (offset > MAX_UINT32) throw new Error('portable bundle exceeds the 4 GiB non-ZIP64 limit')
  }
  const centralOffset = offset
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // central directory disk
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20) // comment length
  return Buffer.concat([...chunks, centralBuffer, end])
}

function findEndOfCentralDirectory(buffer) {
  const minimum = 22
  if (buffer.length < minimum) throw new Error('not a ZIP file: shorter than the end-of-central-directory record')
  const lastStart = Math.max(0, buffer.length - minimum - 0xffff)
  for (let offset = buffer.length - minimum; offset >= lastStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + minimum + commentLength !== buffer.length) continue
    return offset
  }
  throw new Error('not a ZIP file: end-of-central-directory record not found')
}

/**
 * Parse and fully verify a ZIP buffer (central directory + every local header +
 * CRC-32 + sizes). Returns JSON-ready data; throws on structural corruption.
 */
export function readZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('readZip expects a Buffer')
  const endOffset = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (buffer.readUInt16LE(endOffset + 8) !== entryCount) throw new Error('ZIP uses multi-disk archives, which are not supported')
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP central directory is out of bounds')
  const entries = []
  const seen = new Set()
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset) throw new Error('ZIP central directory entry ' + index + ' is truncated')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) throw new Error('ZIP central directory entry ' + index + ' has a bad signature')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > endOffset) throw new Error('ZIP entry name is out of bounds')
    const name = buffer.subarray(nameStart, nameEnd).toString((flags & UTF8_FLAG) !== 0 ? 'utf8' : 'latin1')
    if (seen.has(name)) throw new Error('duplicate ZIP entry: ' + name)
    seen.add(name)
    cursor = nameEnd + extraLength + commentLength

    if (localOffset + 30 > buffer.length) throw new Error('ZIP entry ' + name + ' has an out-of-bounds local header')
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) throw new Error('ZIP entry ' + name + ' has a bad local header signature')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')
    if (localName !== name) throw new Error('ZIP entry ' + name + ' local header name does not match the central directory')
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error('ZIP entry ' + name + ' data is out of bounds')
    const raw = buffer.subarray(dataStart, dataEnd)
    let data
    if (method === METHOD_STORE) data = Buffer.from(raw)
    else if (method === METHOD_DEFLATE) data = inflateRawSync(raw)
    else throw new Error('ZIP entry ' + name + ' uses unsupported compression method ' + method)
    if (data.length !== uncompressedSize) throw new Error('ZIP entry ' + name + ' has an unexpected uncompressed size')
    if (crc32(data) !== checksum) throw new Error('ZIP entry ' + name + ' failed its CRC-32 check')
    entries.push({
      name,
      method: method === METHOD_STORE ? 'store' : 'deflate',
      size: data.length,
      compressedSize,
      crc32: checksum.toString(16).padStart(8, '0'),
    })
    if (options.withData) entries[entries.length - 1].data = data
  }
  if (cursor !== centralOffset + centralSize) throw new Error('ZIP central directory size does not match its entries')
  return {
    entries,
    entryCount,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    totalCompressedBytes: entries.reduce((sum, entry) => sum + entry.compressedSize, 0),
  }
}

/** Extract a ZIP buffer to a directory after rejecting unsafe entry names. */
export function extractZip(buffer, destination) {
  const archive = readZip(buffer, { withData: true })
  const base = resolve(destination)
  const written = []
  for (const entry of archive.entries) {
    if (!safeEntryName(entry.name)) throw new Error('refusing to extract unsafe ZIP entry: ' + entry.name)
    const parts = toPosixPath(entry.name).split('/').filter(Boolean)
    const target = resolve(join(base, ...parts))
    const guard = base.endsWith(sep) ? base : base + sep
    if (target !== base && !target.startsWith(guard)) throw new Error('refusing to extract ZIP entry outside the destination: ' + entry.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    written.push(entry.name)
  }
  return { entries: archive.entries.map(({ data, ...entry }) => entry), written }
}

/**
 * Verify a ZIP buffer as a release artifact. Pure: returns JSON-ready results.
 * @param {Buffer} buffer
 * @param {{expectedSha256?: string, requiredEntries?: string[], archiveName?: string}} options
 */
export function verifyZipBuffer(buffer, options = {}) {
  const errors = []
  let archive = { entries: [], entryCount: 0, totalBytes: 0 }
  try {
    archive = readZip(buffer)
  } catch (error) {
    errors.push('archive is not a readable ZIP: ' + String(error.message || error))
  }
  const digest = sha256(buffer)
  if (options.expectedSha256) {
    const expected = String(options.expectedSha256).trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expected)) errors.push('expected SHA-256 is not a 64-char hex digest')
    else if (expected !== digest) errors.push('SHA-256 mismatch: expected ' + expected + ', got ' + digest)
  }
  const names = new Set(archive.entries.map((entry) => entry.name))
  for (const name of options.requiredEntries || []) {
    if (!names.has(name)) errors.push('required entry is missing: ' + name)
  }
  for (const entry of archive.entries) {
    if (!safeEntryName(entry.name)) errors.push('unsafe entry name: ' + entry.name)
  }
  return {
    ok: errors.length === 0,
    errors,
    sha256: digest,
    archiveName: options.archiveName || '',
    entryCount: archive.entryCount,
    totalBytes: archive.totalBytes,
    entries: archive.entries,
  }
}

/** Read `<file>` and verify it as a portable release artifact. */
export function verifyZipFile(file, options = {}) {
  if (!existsSync(file)) return { ok: false, errors: ['file does not exist: ' + file], sha256: '', entryCount: 0, totalBytes: 0, entries: [] }
  const buffer = readFileSync(file)
  const result = verifyZipBuffer(buffer, { ...options, archiveName: options.archiveName || file })
  return { ...result, file }
}

/** Format of a sha256sum-compatible sidecar / SHA256SUMS line. */
export function formatSha256Line(digest, fileName) {
  return digest + '  ' + fileName + '\n'
}

/** Write `<zip>.sha256` next to a release artifact (sha256sum -c compatible). */
export function writeSha256Sidecar(file, digest) {
  const sidecar = file + '.sha256'
  writeFileSync(sidecar, formatSha256Line(digest, file.split(/[\\/]/).pop()))
  return sidecar
}

/** Parse a sha256sum-style file into a Map<basename, digest>. */
export function parseSha256Sums(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed)
    if (!match) continue
    map.set(match[2].trim().replace(/^[.][\\/]/, ''), match[1].toLowerCase())
  }
  return map
}

function walkFixtureTree(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else files.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

function fail(message) {
  process.stderr.write('FAIL ' + message + '\n')
  return 1
}

function pass(message) {
  process.stdout.write('PASS ' + message + '\n')
}

/** Deterministic archive self-test: runs anywhere (Linux, macOS, Windows), no network. */
export function runSelfTest() {
  const temp = mkdtempSync(join(tmpdir(), 'advisers-portable-zip-'))
  let failures = 0
  const check = (name, ok, detail = '') => {
    if (ok) pass(name)
    else {
      failures += 1
      process.stderr.write('FAIL ' + name + (detail ? ': ' + detail : '') + '\n')
    }
  }
  try {
    const tree = join(temp, 'tree')
    mkdirSync(join(tree, 'nested', 'deep'), { recursive: true })
    const binary = Buffer.alloc(1024)
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251
    writeFileSync(join(tree, 'hello.txt'), 'hello portable world\n')
    writeFileSync(join(tree, 'empty.bin'), Buffer.alloc(0))
    writeFileSync(join(tree, 'binary.dat'), binary)
    writeFileSync(join(tree, 'nested', 'data-数据.txt'), 'unicode name and content\n')
    writeFileSync(join(tree, 'nested', 'deep', 'run.js'), 'console.log("ok")\n')

    const first = zipDirectory(tree, { prefix: 'bundle' })
    const second = zipDirectory(tree, { prefix: 'bundle' })
    check('deterministic: two builds of the same tree are byte-identical', sha256(first) === sha256(second), sha256(first) + ' != ' + sha256(second))

    const archive = readZip(first)
    check('archive lists every file', archive.entryCount === 5 && archive.entries.length === 5, 'entries=' + archive.entryCount)
    check('archive totals the uncompressed bytes', archive.totalBytes === walkFixtureTree(tree).reduce((sum, file) => sum + statSync(join(tree, ...file.split('/'))).size, 0))
    check(
      'archive names keep the requested prefix',
      archive.entries.every((entry) => entry.name.startsWith('bundle/')),
    )

    const extracted = join(temp, 'extracted')
    extractZip(first, extracted)
    const roundTrip = walkFixtureTree(tree).every((file) => {
      const source = join(tree, ...file.split('/'))
      const target = join(extracted, 'bundle', ...file.split('/'))
      return existsSync(target) && Buffer.compare(readFileSync(source), readFileSync(target)) === 0
    })
    check('extract round-trips every file byte-for-byte', roundTrip)

    const zipFile = join(temp, 'bundle.zip')
    writeFileSync(zipFile, first)
    const digest = sha256(first)
    const sidecar = writeSha256Sidecar(zipFile, digest)
    const sums = parseSha256Sums(readFileSync(sidecar, 'utf8'))
    check('sidecar round-trips the digest', sums.get('bundle.zip') === digest, sidecar)
    const verified = verifyZipFile(zipFile, { expectedSha256: digest, requiredEntries: ['bundle/hello.txt'] })
    check('verify accepts a good archive with an expected digest', verified.ok, JSON.stringify(verified.errors))
    check('verify reports the file digest', verified.sha256 === digest)

    const tampered = Buffer.from(first)
    tampered[tampered.length - 30] ^= 0xff
    const tamperedResult = verifyZipBuffer(tampered)
    check('verify rejects a corrupted archive', !tamperedResult.ok, JSON.stringify(tamperedResult.errors).slice(0, 200))

    const unsafe = Buffer.from(first)
    const findName = Buffer.from('bundle/hello.txt')
    const replaceWith = Buffer.from(('/evil.txt' + 'x'.repeat(findName.length)).slice(0, findName.length))
    for (let index = unsafe.indexOf(findName); index >= 0; index = unsafe.indexOf(findName, index + 1)) {
      replaceWith.copy(unsafe, index)
    }
    const unsafeResult = verifyZipBuffer(unsafe)
    check('verify rejects path-traversal entry names', !unsafeResult.ok, JSON.stringify(unsafeResult.errors).slice(0, 200))

    if (process.platform !== 'win32') {
      const linkTree = join(temp, 'link-tree')
      mkdirSync(linkTree, { recursive: true })
      writeFileSync(join(linkTree, 'real.txt'), 'target content\n')
      symlinkSync('real.txt', join(linkTree, 'link.txt'))
      let refused = false
      try {
        zipDirectory(linkTree)
      } catch (error) {
        refused = /symlink/.test(String(error.message))
      }
      check('zipDirectory refuses symlinks by default', refused)
      const followed = readZip(zipDirectory(linkTree, { followSymlinks: true }))
      check('followSymlinks stores a symlinked file as a regular entry', followed.entries.some((entry) => entry.name === 'link.txt') && followed.entries.some((entry) => entry.name === 'real.txt'))
      const outsideFile = join(temp, 'outside.txt')
      writeFileSync(outsideFile, 'outside\n')
      symlinkSync(outsideFile, join(linkTree, 'escape.txt'))
      let escapeRefused = false
      try {
        zipDirectory(linkTree, { followSymlinks: true })
      } catch (error) {
        escapeRefused = /escapes the bundle/.test(String(error.message))
      }
      check('followSymlinks refuses a symlink that escapes the bundle', escapeRefused)
    }

    const missing = verifyZipBuffer(first, { requiredEntries: ['bundle/missing.txt'] })
    check('verify reports missing required entries', !missing.ok && missing.errors.some((error) => error.includes('bundle/missing.txt')))

    const badDigest = verifyZipBuffer(first, { expectedSha256: '0'.repeat(64) })
    check('verify reports a digest mismatch', !badDigest.ok && badDigest.errors.some((error) => error.includes('SHA-256 mismatch')))

    // Wrapped prefix stays flat (the release zip extracts to one folder).
    const prefixed = zipDirectory(tree, { prefix: 'advisers-0.4.0-win-x64' })
    check('release-style prefix produces the expected top directory', readZip(prefixed).entries.every((entry) => entry.name.startsWith('advisers-0.4.0-win-x64/')))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  if (failures > 0) {
    process.stderr.write('\nFAIL portable-zip self-test (' + failures + ' failure(s))\n')
    return 1
  }
  process.stdout.write('\nPASS portable-zip self-test\n')
  return 0
}

function printHelp() {
  process.stdout.write(
    [
      'portable-zip — deterministic ZIP codec + verifier for the Advisers offline bundle',
      '',
      'Usage:',
      '  node scripts/portable-zip.mjs                          self-test (no arguments)',
      '  node scripts/portable-zip.mjs --self-test',
      '  node scripts/portable-zip.mjs --build <dir> --out <zip> [--prefix <name>]',
      '  node scripts/portable-zip.mjs --verify <zip> [--sha256 <hex>] [--sidecar] [--required <a,b>]',
      '  node scripts/portable-zip.mjs --list <zip>',
      '  node scripts/portable-zip.mjs --extract <zip> --dest <dir>',
      '',
      'The codec is dependency-free (node:zlib raw deflate + a local CRC-32) and',
      'produces the same bytes for the same input tree on every operating system.',
      'The release artifact is built by scripts/pack-portable.mjs.',
      '',
    ].join('\n'),
  )
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return ''
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value')
  return value
}

function main(argv) {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      printHelp()
      return 0
    }
    if (argv.length === 0 || argv.includes('--self-test')) return runSelfTest()
    if (argv.includes('--build')) {
      const root = argValue(argv, '--build')
      const out = argValue(argv, '--out')
      const prefix = argValue(argv, '--prefix')
      const buffer = zipDirectory(root, { prefix })
      mkdirSync(dirname(resolve(out)), { recursive: true })
      writeFileSync(out, buffer)
      process.stdout.write('PASS built ' + resolve(out) + ' (' + formatBytes(buffer.length) + ', ' + readZip(buffer).entryCount + ' entries, sha256 ' + sha256(buffer) + ')\n')
      return 0
    }
    if (argv.includes('--verify')) {
      const zip = argValue(argv, '--verify')
      const expectedSha = argValue(argv, '--sha256')
      const required = (argValue(argv, '--required') || '').split(',').map((value) => value.trim()).filter(Boolean)
      let expected = expectedSha
      if (!expected && existsSync(zip + '.sha256')) {
        const sidecar = parseSha256Sums(readFileSync(zip + '.sha256', 'utf8'))
        expected = [...sidecar.values()][0] || ''
      }
      const result = verifyZipFile(zip, { expectedSha256: expected, requiredEntries: required })
      if (!result.ok) {
        for (const error of result.errors) process.stderr.write('FAIL ' + error + '\n')
        return 1
      }
      process.stdout.write('PASS verified ' + resolve(zip) + ' (' + formatBytes(result.totalBytes) + ', ' + result.entryCount + ' entries, sha256 ' + result.sha256 + ')\n')
      return 0
    }
    if (argv.includes('--list')) {
      const zip = argValue(argv, '--list')
      const archive = readZip(readFileSync(zip))
      for (const entry of archive.entries) process.stdout.write(entry.size + '\t' + entry.name + '\n')
      process.stdout.write('PASS listed ' + archive.entryCount + ' entries\n')
      return 0
    }
    if (argv.includes('--extract')) {
      const zip = argValue(argv, '--extract')
      const dest = argValue(argv, '--dest')
      const result = extractZip(readFileSync(zip), dest)
      process.stdout.write('PASS extracted ' + result.written.length + ' entries to ' + resolve(dest) + '\n')
      return 0
    }
    printHelp()
    return 2
  } catch (error) {
    return fail(String(error && error.message ? error.message : error))
  }
}

const directInvocation = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
if (directInvocation) process.exit(main(process.argv.slice(2)))
