import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLIENT_PACK_LIMIT_CODE,
  CLIENT_PACK_LIMIT_DEFAULTS,
  CLIENT_PACK_SHA256SUMS_FILE,
  exportClientStatusPack,
  parseClientPackSums,
  readClientPackManifestHeader,
  verifyClientStatusPackDir,
} from '../lib/client-pack.js'

// Offline verifier for untrusted client status packs (0.4.0): tamper/missing/
// extra-file detection, schema drift, money-field rejection, resource limits and
// dispatch. Each case builds a genuine pack on disk first, then breaks exactly
// one thing (re-signing SHA256SUMS when the change is manifest-level so the
// failure is the intended one, not a hash mismatch).

const LF = String.fromCharCode(10)

function setup(prefix = 'advisers-client-pack-verify-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, out: join(root, 'pack') }
}

function statusPayload() {
  return {
    ok: true,
    command: 'client export',
    format: 'md',
    scope: 'client',
    subject: { kind: 'client', id: 'cl_wang', name: '王工' },
    generatedAt: '2026-11-21T00:00:00.000Z',
    clearance: 0,
    protectedExcluded: 0,
    counts: { matters: 1, openWaiting: 1 },
    nextDueAt: null,
    disclaimer: true,
  }
}

function makePack(out) {
  exportClientStatusPack({ status: statusPayload(), markdown: '# sheet' + LF, outDir: out, env: { advisersVersion: '0.4.0' }, generatedAt: '2026-11-21T00:00:00.000Z' })
  return out
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Recompute SHA256SUMS from the files on disk (except itself), sorted. */
function resign(dir) {
  const names = readFileSync(join(dir, CLIENT_PACK_SHA256SUMS_FILE), 'utf8')
    .split(LF)
    .filter(Boolean)
    .map((line) => line.slice(66))
    .sort()
  const lines = names.map((name) => sha256Hex(readFileSync(join(dir, name))) + '  ' + name)
  writeFileSync(join(dir, CLIENT_PACK_SHA256SUMS_FILE), lines.join(LF) + LF)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + LF)
}

function editManifest(dir, mutate) {
  const file = join(dir, 'manifest.json')
  const manifest = readJson(file)
  mutate(manifest)
  writeJson(file, manifest)
  resign(dir)
}

function hasError(result, pattern) {
  return result.errors.some((error) => pattern.test(error))
}

test('a genuine pack verifies and reports the documented result shape', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    const result = verifyClientStatusPackDir(out)
    for (const key of ['ok', 'code', 'errors', 'warnings', 'dir', 'format', 'version', 'subject', 'scope', 'verificationBasis', 'fileCount', 'checksumCount', 'files', 'checksums', 'manifest', 'totalBytes', 'limits', 'limitViolation']) {
      assert.ok(key in result, 'result has ' + key)
    }
    assert.equal(result.ok, true)
    assert.equal(result.code, null)
    assert.equal(result.format, 'advisers-client-status-pack')
    assert.equal(result.version, 1)
    assert.equal(result.scope, 'client')
    assert.equal(result.verificationBasis, 'local-checksums-only')
    assert.equal(result.fileCount, 5)
    assert.equal(result.checksumCount, 4)
    assert.ok(result.warnings.some((warning) => /internal consistency only/.test(warning)))
    assert.equal(result.manifest.format, 'advisers-client-status-pack')
    assert.deepEqual(result.subject, { kind: 'client', id: 'cl_wang', name: '王工' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('any edited byte flips ok to false (hash mismatch), including status.json and manifest.json', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    for (const file of ['status.md', 'status.json', 'manifest.json', 'README.txt']) {
      const original = readFileSync(join(out, file))
      writeFileSync(join(out, file), Buffer.concat([original, Buffer.from('x')]))
      const result = verifyClientStatusPackDir(out)
      assert.equal(result.ok, false, file + ' tamper is detected')
      assert.ok(hasError(result, /hash mismatch|not valid JSON/), file + ' reports a hash/JSON error')
      writeFileSync(join(out, file), original)
    }
    assert.equal(verifyClientStatusPackDir(out).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('schema drift: format, version, scope, basis, subject, generatedAt, counts are pinned', () => {
  const { root, out } = setup()
  try {
    const cases = [
      ['format', (manifest) => { manifest.format = 'advisers-delivery-receipt-pack' }, /manifest.format/],
      ['version', (manifest) => { manifest.version = 2 }, /manifest.version/],
      ['scope', (manifest) => { manifest.scope = 'local-all' }, /manifest.scope/],
      ['basis', (manifest) => { manifest.verificationBasis = 'build-time' }, /verificationBasis/],
      ['subject kind', (manifest) => { manifest.subject.kind = 'project' }, /manifest.subject/],
      ['subject missing id', (manifest) => { manifest.subject.id = '' }, /manifest.subject/],
      ['generatedAt', (manifest) => { manifest.generatedAt = 'yesterday' }, /generatedAt/],
      ['counts', (manifest) => { manifest.counts = 'many' }, /manifest.counts/],
    ]
    for (const [label, mutate, pattern] of cases) {
      makePack(out)
      editManifest(out, mutate)
      const result = verifyClientStatusPackDir(out)
      assert.equal(result.ok, false, label + ' drift is rejected')
      assert.ok(hasError(result, pattern), label + ' reports ' + pattern)
      rmSync(out, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file list and checksum coverage must agree exactly', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    editManifest(out, (manifest) => { manifest.fileCount = 99 })
    assert.ok(hasError(verifyClientStatusPackDir(out), /fileCount/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    editManifest(out, (manifest) => { manifest.files = manifest.files.filter((file) => file.path !== 'README.txt') })
    const missing = verifyClientStatusPackDir(out)
    assert.equal(missing.ok, false)
    assert.ok(hasError(missing, /manifest.files does not list README.txt|manifest.files does not list/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    editManifest(out, (manifest) => {
      manifest.files.push({ path: 'extra.txt', size: 1, sha256: 'a'.repeat(64) })
      manifest.fileCount += 1
    })
    assert.ok(hasError(verifyClientStatusPackDir(out), /manifest.files lists extra.txt/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    const manifest = readJson(join(out, 'manifest.json'))
    manifest.files[0].sha256 = 'b'.repeat(64)
    writeJson(join(out, 'manifest.json'), manifest)
    resign(out)
    assert.ok(hasError(verifyClientStatusPackDir(out), /manifest sha256 disagrees with SHA256SUMS/))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unlisted extra file, a missing required file and a self-listed SHA256SUMS are all rejected', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    writeFileSync(join(out, 'smuggled.bin'), 'payload')
    const extra = verifyClientStatusPackDir(out)
    assert.equal(extra.ok, false)
    assert.ok(hasError(extra, /file not covered by SHA256SUMS: smuggled.bin/))
    unlinkSync(join(out, 'smuggled.bin'))
    assert.equal(verifyClientStatusPackDir(out).ok, true)

    unlinkSync(join(out, 'README.txt'))
    const missing = verifyClientStatusPackDir(out)
    assert.equal(missing.ok, false)
    assert.ok(hasError(missing, /missing file: README.txt/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    writeFileSync(join(out, CLIENT_PACK_SHA256SUMS_FILE), readFileSync(join(out, CLIENT_PACK_SHA256SUMS_FILE), 'utf8') + sha256Hex(Buffer.from('x')) + '  ' + CLIENT_PACK_SHA256SUMS_FILE + LF)
    assert.ok(hasError(verifyClientStatusPackDir(out), /must not list itself/))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('malformed, duplicate and unsafe SHA256SUMS entries are rejected by parse and verifier', () => {
  const good = 'a'.repeat(64) + '  status.md' + LF
  assert.equal(parseClientPackSums(good).entries.get('status.md'), 'a'.repeat(64))
  assert.ok(parseClientPackSums('not a checksum').errors.length > 0)
  assert.ok(parseClientPackSums('A'.repeat(64) + '  status.md').errors.length > 0, 'uppercase digest is not coreutils canonical')
  assert.ok(parseClientPackSums('a'.repeat(64) + ' status.md').errors.length > 0, 'one space is rejected')
  assert.ok(parseClientPackSums('a'.repeat(64) + '  ../escaped').errors.length > 0)
  assert.ok(parseClientPackSums('a'.repeat(64) + '  /abs').errors.length > 0)
  assert.ok(parseClientPackSums('a'.repeat(64) + '  status.md' + LF + 'b'.repeat(64) + '  status.md').errors.length > 0)
  assert.ok(parseClientPackSums('a'.repeat(64) + '  status.md' + LF + 'c'.repeat(64) + '  ' + CLIENT_PACK_SHA256SUMS_FILE).errors.length > 0)

  const { root, out } = setup()
  try {
    makePack(out)
    writeFileSync(join(out, CLIENT_PACK_SHA256SUMS_FILE), 'not a checksum' + LF)
    const result = verifyClientStatusPackDir(out)
    assert.equal(result.ok, false)
    assert.ok(hasError(result, /malformed SHA256SUMS/))
    assert.ok(hasError(result, /does not cover manifest.json/))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status.json must describe the same subject and must not contain money fields', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    const statusFile = join(out, 'status.json')
    const status = readJson(statusFile)
    status.subject = { kind: 'client', id: 'cl_other', name: '别人' }
    writeJson(statusFile, status)
    resign(out)
    assert.ok(hasError(verifyClientStatusPackDir(out), /subject id disagrees/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    const withMoney = readJson(statusFile)
    withMoney.receivables = { count: 1, amountMinor: 100 }
    writeJson(statusFile, withMoney)
    resign(out)
    const money = verifyClientStatusPackDir(out)
    assert.equal(money.ok, false)
    assert.ok(hasError(money, /money fields/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    writeFileSync(statusFile, '{not json')
    resign(out)
    assert.ok(hasError(verifyClientStatusPackDir(out), /status.json is not valid JSON/))
    rmSync(out, { recursive: true, force: true })

    makePack(out)
    writeFileSync(join(out, 'status.md'), '   ' + LF)
    resign(out)
    assert.ok(hasError(verifyClientStatusPackDir(out), /status.md is empty/))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resource limits fail closed with E_CLIENT_PACK_LIMIT and structured metadata', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    const entryLimited = verifyClientStatusPackDir(out, { limits: { maxEntries: 2 } })
    assert.equal(entryLimited.ok, false)
    assert.equal(entryLimited.code, CLIENT_PACK_LIMIT_CODE)
    assert.equal(entryLimited.limitViolation.limit, 'maxEntries')
    const fileLimited = verifyClientStatusPackDir(out, { limits: { maxFileBytes: 10 } })
    assert.equal(fileLimited.code, CLIENT_PACK_LIMIT_CODE)
    assert.equal(fileLimited.limitViolation.limit, 'maxFileBytes')
    const sumsLimited = verifyClientStatusPackDir(out, { limits: { maxSumsBytes: 10 } })
    assert.equal(sumsLimited.code, CLIENT_PACK_LIMIT_CODE)
    assert.equal(sumsLimited.limitViolation.limit, 'maxSumsBytes')
    const manifestLimited = verifyClientStatusPackDir(out, { limits: { maxManifestBytes: 10 } })
    assert.equal(manifestLimited.code, CLIENT_PACK_LIMIT_CODE)
    assert.equal(manifestLimited.limitViolation.limit, 'maxManifestBytes')
    assert.equal(CLIENT_PACK_LIMIT_DEFAULTS.maxEntries > 0, true)
    // Default limits accept the genuine pack.
    assert.equal(verifyClientStatusPackDir(out).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bad paths: nonexistent, a file, and a symlink inside the pack', () => {
  const { root, out } = setup()
  try {
    assert.equal(verifyClientStatusPackDir(join(root, 'missing')).ok, false)
    writeFileSync(join(root, 'a-file'), 'x')
    const notDir = verifyClientStatusPackDir(join(root, 'a-file'))
    assert.equal(notDir.ok, false)
    assert.ok(hasError(notDir, /not a directory/))
    assert.equal(verifyClientStatusPackDir('').ok, false)
    if (process.platform !== 'win32') {
      makePack(out)
      symlinkSync(join(out, 'status.md'), join(out, 'link.md'))
      const linked = verifyClientStatusPackDir(out)
      assert.equal(linked.ok, false)
      assert.ok(hasError(linked, /symbolic links are not allowed/))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a receipt pack is not accepted as a client status pack (independent verifiers)', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    editManifest(out, (manifest) => {
      manifest.format = 'advisers-delivery-receipt-pack'
      manifest.version = 2
    })
    const asReceipt = verifyClientStatusPackDir(out)
    assert.equal(asReceipt.ok, false)
    assert.ok(hasError(asReceipt, /manifest.format/))
    // The dispatch header exposes the declared format so bin can route it.
    const header = readClientPackManifestHeader(out)
    assert.equal(header.ok, true)
    assert.equal(header.format, 'advisers-delivery-receipt-pack')
    assert.equal(header.version, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readClientPackManifestHeader bounds its read and reports missing/broken manifests', () => {
  const { root, out } = setup()
  try {
    assert.equal(readClientPackManifestHeader(join(root, 'missing')).ok, false)
    assert.equal(readClientPackManifestHeader(out).ok, false)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'manifest.json'), '{broken')
    const broken = readClientPackManifestHeader(out)
    assert.equal(broken.ok, false)
    assert.ok(broken.error)
    writeJson(join(out, 'manifest.json'), { format: 'advisers-client-status-pack', version: 1 })
    assert.deepEqual(readClientPackManifestHeader(out), { ok: true, format: 'advisers-client-status-pack', version: 1, error: null })
    const limited = readClientPackManifestHeader(out, { limits: { maxManifestBytes: 5 } })
    assert.equal(limited.ok, false)
    assert.match(limited.error, /size limit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a depth limit trips on nested directories', () => {
  const { root, out } = setup()
  try {
    makePack(out)
    mkdirSync(join(out, 'a', 'b'), { recursive: true })
    writeFileSync(join(out, 'a', 'b', 'nested.txt'), 'x')
    const result = verifyClientStatusPackDir(out, { limits: { maxDepth: 1 } })
    assert.equal(result.ok, false)
    assert.equal(result.code, CLIENT_PACK_LIMIT_CODE)
    assert.equal(result.limitViolation.limit, 'maxDepth')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
