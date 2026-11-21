import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLIENT_PACK_DIR_MODE,
  CLIENT_PACK_FILE_MODE,
  CLIENT_PACK_MANIFEST_FORMAT,
  CLIENT_PACK_MANIFEST_VERSION,
  CLIENT_PACK_REQUIRED_FILES,
  CLIENT_PACK_SHA256SUMS_FILE,
  CLIENT_PACK_VERIFICATION_BASIS,
  buildClientStatusPack,
  exportClientStatusPack,
  readClientPackManifestHeader,
  verifyClientStatusPackDir,
  writeClientStatusPackDir,
} from '../lib/client-pack.js'

// Client status pack v2 (0.4.0): directory layout, manifest, SHA256SUMS,
// atomic write discipline, 0.4.0 money exclusion and the offline verifier
// happy path. Temporary directories only; ADVISERS_HOME is never read.

const LF = String.fromCharCode(10)

function setup(prefix = 'advisers-client-pack-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, out: join(root, 'pack') }
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** A realistic subset of the client export --json payload (0.3.2 shape). */
function statusPayload(extra = {}) {
  return {
    ok: true,
    command: 'client export',
    format: 'md',
    scope: 'client',
    subject: { kind: 'client', id: 'cl_wang', name: '王工' },
    out: '/home/me/.advisers/exports/client-cl_wang.md',
    bytes: 1371,
    sha256: 'ab'.repeat(32),
    generatedAt: '2026-11-21T00:00:00.000Z',
    clearance: 0,
    protectedExcluded: 0,
    counts: { matters: 2, mattersArchived: 0, deliveries: 1, notes: 1, commitments: 1, openMine: 0, openWaiting: 1, overdue: 0 },
    nextDueAt: '2026-12-15T23:59:59.999+08:00',
    timelineCount: 1,
    timelineTotal: 1,
    timelineTruncated: false,
    disclaimer: true,
    ...extra,
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sumsMap(dir) {
  const text = readFileSync(join(dir, CLIENT_PACK_SHA256SUMS_FILE), 'utf8')
  const map = new Map()
  for (const line of text.split(LF)) {
    if (!line) continue
    map.set(line.slice(66), line.slice(0, 64))
  }
  return map
}

test('buildClientStatusPack returns the contracted layout and strips the self-referencing fields', () => {
  const { root } = setup()
  try {
    const built = buildClientStatusPack({
      status: statusPayload(),
      markdown: '# 客户状态包 · 王工' + LF + LF + '状态说明' + LF,
      generatedAt: '2026-11-21T01:02:03.000Z',
      env: { advisersVersion: '0.4.0' },
    })
    assert.deepEqual([...built.files.keys()].sort(), ['README.txt', 'SHA256SUMS', 'manifest.json', 'status.json', 'status.md'])
    const manifest = built.manifest
    assert.equal(manifest.format, CLIENT_PACK_MANIFEST_FORMAT)
    assert.equal(manifest.format, 'advisers-client-status-pack')
    assert.equal(manifest.version, CLIENT_PACK_MANIFEST_VERSION)
    assert.equal(manifest.version, 1)
    assert.equal(manifest.scope, 'client')
    assert.deepEqual(manifest.subject, { kind: 'client', id: 'cl_wang', name: '王工' })
    assert.equal(manifest.generatedAt, '2026-11-21T01:02:03.000Z')
    assert.equal(manifest.verificationBasis, CLIENT_PACK_VERIFICATION_BASIS)
    assert.equal(manifest.verificationBasis, 'local-checksums-only')
    assert.deepEqual(manifest.counts, statusPayload().counts)
    assert.equal(manifest.disclaimer, true)
    assert.equal(manifest.generator.advisersVersion, '0.4.0')
    // files[] lists the data files (never manifest.json or SHA256SUMS itself).
    assert.deepEqual(manifest.files.map((file) => file.path), ['README.txt', 'status.json', 'status.md'])
    assert.equal(manifest.fileCount, 3)
    // status.json is the payload minus out/bytes/sha256.
    const statusJson = JSON.parse(built.files.get('status.json').toString('utf8'))
    assert.equal(statusJson.out, undefined)
    assert.equal(statusJson.bytes, undefined)
    assert.equal(statusJson.sha256, undefined)
    const expected = statusPayload()
    delete expected.out
    delete expected.bytes
    delete expected.sha256
    assert.deepEqual(statusJson, expected)
    // README carries the scope, disclaimer and verification instructions.
    const readme = built.files.get('README.txt').toString('utf8')
    assert.match(readme, /Verification basis: local-checksums-only/)
    assert.match(readme, /advisers evidence verify/)
    assert.match(readme, /not a statement of account/)
    assert.match(readme, /does NOT contain receivable/)
    // SHA256SUMS covers manifest.json + every data file, not itself.
    const sums = built.files.get('SHA256SUMS').toString('utf8')
    const names = sums.trim().split(LF).map((line) => line.slice(66)).sort()
    assert.deepEqual(names, ['README.txt', 'manifest.json', 'status.json', 'status.md'])
    assert.equal(built.summary.checksumCount, 4)
    assert.equal(built.summary.fileCount, 3)
    assert.equal(built.manifestDigest, sha256Hex(built.manifestText))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the builder is deterministic and renders a fallback status.md when markdown is omitted', () => {
  const { root } = setup()
  try {
    const options = { status: statusPayload(), generatedAt: '2026-11-21T00:00:00.000Z', env: { advisersVersion: '0.4.0' } }
    const first = buildClientStatusPack(options)
    const second = buildClientStatusPack(options)
    for (const name of first.files.keys()) {
      assert.equal(first.files.get(name).toString('base64'), second.files.get(name).toString('base64'), name + ' is byte-identical')
    }
    const fallback = first.files.get('status.md').toString('utf8')
    assert.match(fallback, /^# 客户状态包 · 王工/)
    assert.match(fallback, /不是对账单/)
    assert.match(fallback, /counts|概况/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('0.4.0 excludes receivables: includeReceivables fails closed and a money field is rejected', () => {
  const { root } = setup()
  try {
    const base = { status: statusPayload(), markdown: '# x' + LF }
    assert.throws(() => buildClientStatusPack({ ...base, includeReceivables: true }), /E_CLIENT_PACK_RECEIVABLES_UNSUPPORTED/)
    assert.throws(() => buildClientStatusPack({ ...base, includeReceivables: 'yes' }), /includeReceivables must be a boolean/)
    // Top-level and nested money-like keys are refused by the builder...
    assert.throws(() => buildClientStatusPack({ status: statusPayload({ receivables: { count: 1 } }), markdown: '# x' + LF }), /must not contain money fields/)
    assert.throws(() => buildClientStatusPack({ status: statusPayload({ counts: { ...statusPayload().counts, amountMinor: 100 } }), markdown: '# x' + LF }), /amountMinor/)
    // ...and a valid status needs a real subject.
    assert.throws(() => buildClientStatusPack({ status: statusPayload({ subject: { kind: 'project', id: 'prj', name: 'x' } }) }), /subject kind must be "client"/)
    assert.throws(() => buildClientStatusPack({ status: statusPayload({ subject: undefined }) }), /requires a subject/)
    assert.throws(() => buildClientStatusPack({ status: 'nope' }), /status payload/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportClientStatusPack writes 0700/0600 files, a valid pack and a verifiable summary', () => {
  const { root, out } = setup()
  try {
    const summary = exportClientStatusPack({
      status: statusPayload(),
      markdown: '# 客户状态包 · 王工' + LF,
      generatedAt: '2026-11-21T00:00:00.000Z',
      outDir: out,
      env: { advisersVersion: '0.4.0' },
    })
    assert.equal(summary.ok, true)
    assert.equal(summary.format, CLIENT_PACK_MANIFEST_FORMAT)
    assert.equal(summary.version, 1)
    assert.equal(summary.scope, 'client')
    assert.equal(summary.out, out)
    assert.equal(summary.includeReceivables, false)
    assert.equal(summary.fileCount, 3)
    assert.equal(summary.checksumCount, 4)
    assert.equal(summary.bytes, readdirSync(out).reduce((sum, name) => sum + statSync(join(out, name)).size, 0))
    assert.equal(summary.verification.ok, true)
    assert.equal(summary.verification.errors.length, 0)
    assert.equal(summary.verification.format, CLIENT_PACK_MANIFEST_FORMAT)
    assert.equal(summary.verification.version, 1)
    assert.equal(summary.verification.fileCount, 5)
    assert.equal(summary.verification.checksumCount, 4)
    assert.deepEqual(readdirSync(out).sort(), ['README.txt', 'SHA256SUMS', 'manifest.json', 'status.json', 'status.md'])
    assert.equal(readJson(join(out, 'manifest.json')).format, CLIENT_PACK_MANIFEST_FORMAT)
    // Bytes on disk match the manifest records.
    const manifest = readJson(join(out, 'manifest.json'))
    for (const record of manifest.files) {
      const bytes = readFileSync(join(out, record.path))
      assert.equal(bytes.length, record.size)
      assert.equal(sha256Hex(bytes), record.sha256)
    }
    if (process.platform !== 'win32') {
      assert.equal(statSync(out).mode & 0o777, CLIENT_PACK_DIR_MODE)
      for (const name of readdirSync(out)) assert.equal(statSync(join(out, name)).mode & 0o777, CLIENT_PACK_FILE_MODE)
    }
    // The direct verifier agrees, and the dispatch header is readable.
    const verified = verifyClientStatusPackDir(out)
    assert.equal(verified.ok, true)
    assert.deepEqual(verified.manifest.subject, { kind: 'client', id: 'cl_wang', name: '王工' })
    assert.deepEqual(readClientPackManifestHeader(out), { ok: true, format: CLIENT_PACK_MANIFEST_FORMAT, version: 1, error: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an optional status.docx is included, covered by SHA256SUMS and verified', () => {
  const { root, out } = setup()
  try {
    const docx = Buffer.from('PK' + String.fromCharCode(3, 4) + 'fake docx bytes')
    const summary = exportClientStatusPack({ status: statusPayload(), markdown: '# x' + LF, docx, outDir: out, env: { advisersVersion: '0.4.0' } })
    assert.deepEqual(summary.files.map((file) => file.path), ['README.txt', 'status.docx', 'status.json', 'status.md'])
    assert.equal(summary.fileCount, 4)
    assert.equal(verifyClientStatusPackDir(out).ok, true)
    assert.ok(sumsMap(out).has('status.docx'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeClientStatusPackDir refuses a non-empty directory and moves the old pack aside on overwrite', () => {
  const { root, out } = setup()
  try {
    const built = buildClientStatusPack({ status: statusPayload(), markdown: '# x' + LF, generatedAt: '2026-11-21T00:00:00.000Z' })
    const written = writeClientStatusPackDir(out, built)
    assert.equal(written.outDir, out)
    assert.equal(written.replaced, null)
    assert.throws(() => writeClientStatusPackDir(out, built), /not empty/)
    const summary = exportClientStatusPack({ status: statusPayload(), markdown: '# y' + LF, outDir: out, overwrite: true, generatedAt: '2026-11-21T01:00:00.000Z' })
    assert.equal(summary.ok, true)
    assert.ok(summary.replaced, 'the previous pack directory is preserved, not deleted')
    assert.ok(existsSync(summary.replaced))
    assert.equal(readJson(join(summary.replaced, 'manifest.json')).generatedAt, '2026-11-21T00:00:00.000Z')
    assert.equal(readJson(join(out, 'manifest.json')).generatedAt, '2026-11-21T01:00:00.000Z')
    // A non-directory target is refused.
    const fileTarget = join(root, 'not-a-dir')
    writeFileSync(fileTarget, 'x')
    assert.throws(() => writeClientStatusPackDir(fileTarget, built, { overwrite: true }), /not a directory/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the verifier needs no HOME and never writes to the pack', () => {
  const { root, out } = setup()
  const previousHome = process.env.ADVISERS_HOME
  try {
    exportClientStatusPack({ status: statusPayload(), markdown: '# x' + LF, outDir: out, env: { advisersVersion: '0.4.0' } })
    const before = readdirSync(out).sort().map((name) => name + ':' + statSync(join(out, name)).size).join(',')
    process.env.ADVISERS_HOME = join(root, 'does-not-exist', 'home')
    const verified = verifyClientStatusPackDir(out)
    assert.equal(verified.ok, true)
    const after = readdirSync(out).sort().map((name) => name + ':' + statSync(join(out, name)).size).join(',')
    assert.equal(before, after)
    assert.equal(existsSync(process.env.ADVISERS_HOME), false)
  } finally {
    if (previousHome === undefined) delete process.env.ADVISERS_HOME
    else process.env.ADVISERS_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('required file list is the frozen layout and README mentions every file', () => {
  const { root } = setup()
  try {
    assert.deepEqual([...CLIENT_PACK_REQUIRED_FILES], ['manifest.json', 'status.md', 'status.json', 'README.txt'])
    assert.equal(CLIENT_PACK_SHA256SUMS_FILE, 'SHA256SUMS')
    const built = buildClientStatusPack({ status: statusPayload(), markdown: '# x' + LF })
    const readme = built.files.get('README.txt').toString('utf8')
    for (const required of CLIENT_PACK_REQUIRED_FILES) assert.ok(readme.includes(required), 'README lists ' + required)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
