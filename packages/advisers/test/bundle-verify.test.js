import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { kbPageRebuild } from '../lib/kb-pages.js'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import {
  BUNDLE_DATA_TABLES,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SHA256SUMS_FILE,
  bundleDataTablesForSchema,
  computeBundleDataDigest,
  exportBundle,
  readBundleManifestHeader,
  verifyBundle,
  verifyBundleDir,
} from '../lib/bundle.js'
import { symlinkOrSkip } from './win-compat.mjs'

// 0.5.0 WF1 050-B1/B2: offline bundle verification. Every negative case must
// fail without writing anything; verification never opens the ledger, never
// creates a HOME and uses node:crypto only (no sha256sum dependency).

const NOW = '2026-11-01T00:00:00.000Z'
const EXPORTED_AT = '2026-11-22T00:00:00.000Z'
const SHA = 'ab'.repeat(32)

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, home: join(root, 'home') }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function seedHome(home) {
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  store.saveWithAudit({
    version: 1,
    matters: [{ id: 'm1', title: 'Verify matter', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW }],
    facts: [{ id: 'f1', matterId: 'm1', subject: '客户', predicate: '预算', object: '10 万', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'active' }],
    commitments: [], preferences: [], links: [], updates: [], routes: {}, routines: [], routinePatches: [],
  }, { actor: 'local', action: 'verify.seed', allowed: true, reason: null })
  store.transaction(() => {
    store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('cl_1', '王工', '王工', '[]', 'active', '[]', 1, null, NOW, NOW)
    store.db.prepare('INSERT INTO kb_documents(id,kind,title,client_id,source_name,source_sha256,size_bytes,extractor,status,secrecy,chunk_count,created_at,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('kb_1', 'note', '验证明细', 'cl_1', 'minutes.md', SHA, 10, 'local', 'active', 0, 1, NOW, NOW)
    store.db.prepare('INSERT INTO kb_chunks(id,doc_id,seq,text,char_count) VALUES(?,?,?,?,?)')
      .run('kc_1', 'kb_1', 1, '验证明细正文', 6)
  })
  kbPageRebuild(store, {})
  store.close()
  return { home, dbPath: join(home, 'state.db') }
}

function listFiles(root, relativeDir = '') {
  const out = []
  const dir = relativeDir ? join(root, ...relativeDir.split('/')) : root
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = relativeDir ? relativeDir + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...listFiles(root, relative))
    else out.push(relative)
  }
  return out.sort()
}

function treeSnapshot(root) {
  return listFiles(root).map((name) => [name, sha256Hex(readFileSync(join(root, ...name.split('/'))))])
}

/** Recompute SHA256SUMS (coreutils form) for every file except itself. */
function resealSums(dir) {
  const lines = listFiles(dir).filter((name) => name !== BUNDLE_SHA256SUMS_FILE)
    .map((name) => sha256Hex(readFileSync(join(dir, ...name.split('/')))) + '  ' + name)
  writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), lines.join(String.fromCharCode(10)) + String.fromCharCode(10))
}

/**
 * Reseal a bundle after editing ledger.json/manifest.json: refresh the manifest
 * file records and every checksum. This models a fully consistent
 * (attacker-recomputed) directory so structural checks can be exercised
 * independently from the raw checksum mismatch.
 */
function resealManifestAndSums(dir) {
  const manifestPath = join(dir, BUNDLE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const records = listFiles(dir)
    .filter((name) => name !== BUNDLE_MANIFEST_FILE && name !== BUNDLE_SHA256SUMS_FILE)
    .map((name) => ({ path: name, size: statSync(join(dir, ...name.split('/'))).size, sha256: sha256Hex(readFileSync(join(dir, ...name.split('/')))) }))
  manifest.files = records
  manifest.fileCount = records.length
  manifest.checksumCount = records.length + 1
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10))
  resealSums(dir)
  return manifest
}

function makeBundle(root, home) {
  const pristine = join(root, 'pristine')
  const exported = exportBundle({ home, outDir: pristine, generatedAt: EXPORTED_AT })
  assert.equal(exported.ok, true, JSON.stringify(exported.errors))
  return pristine
}

function caseDir(root, pristine, name) {
  const dir = join(root, 'case-' + name)
  cpSync(pristine, dir, { recursive: true })
  return dir
}

function assertTampered(result, label) {
  assert.equal(result.ok, false, label + ': expected verification to fail')
  assert.equal(result.code, 'E_BUNDLE_TAMPERED', label + ': expected E_BUNDLE_TAMPERED, got ' + result.code + ' / ' + JSON.stringify(result.errors.slice(0, 3)))
  assert.ok(result.errors.length > 0, label + ': expected errors')
}

function assertInvalid(result, label, pattern) {
  assert.equal(result.ok, false, label + ': expected verification to fail')
  assert.equal(result.code, 'E_BUNDLE_INVALID', label + ': expected E_BUNDLE_INVALID, got ' + result.code + ' / ' + JSON.stringify(result.errors.slice(0, 3)))
  if (pattern) assert.match(result.errors.join(' | '), pattern)
}
test('a genuine bundle verifies and reports the documented result shape', () => {
  const { root, home } = makeRoot('advisers-bundle-verify-')
  try {
    seedHome(home)
    const dir = makeBundle(root, home)
    const result = verifyBundleDir(dir)
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.code, null)
    assert.equal(result.format, 'advisers-bundle')
    assert.equal(result.version, 1)
    assert.equal(result.scope, 'local-all')
    assert.equal(result.subject, null)
    assert.equal(result.verificationBasis, 'local-checksums-only')
    assert.equal(result.generatedAt, EXPORTED_AT)
    assert.equal(result.schemaVersion, SCHEMA_VERSION)
    assert.deepEqual(Object.keys(result.counts).sort(), [...BUNDLE_DATA_TABLES])
    assert.match(result.dataDigest, /^[0-9a-f]{64}$/)
    assert.equal(result.computedDataDigest, result.dataDigest)
    assert.equal(result.manifestDigest, sha256Hex(readFileSync(join(dir, 'manifest.json'))))
    assert.equal(result.fileCount, listFiles(dir).length)
    assert.equal(result.manifest.fileCount, listFiles(dir).length - 2, 'manifest.files lists every file except manifest.json and SHA256SUMS')
    assert.equal(result.checksumCount, result.manifest.checksumCount)
    assert.deepEqual(result.files, listFiles(dir))
    assert.ok(result.totalBytes > 0)
    assert.deepEqual(Object.keys(result.checksums).sort(), listFiles(dir).filter((name) => name !== BUNDLE_SHA256SUMS_FILE).sort())
    assert.equal('payload' in result, false)
    assert.match(result.warnings.join(' '), /verification basis is local-checksums-only/)
    const alias = verifyBundle(dir)
    assert.equal(alias.ok, true)
    assert.equal(alias.dataDigest, result.dataDigest)
    const withPayload = verifyBundleDir(dir, { includePayload: true })
    assert.equal(withPayload.ok, true)
    assert.equal(withPayload.payload.data.clients.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('editing any single byte of a bundled file is detected as tampered', () => {
  const { root, home } = makeRoot('advisers-bundle-tamper-')
  try {
    seedHome(home)
    const pristine = makeBundle(root, home)
    const names = ['ledger.json', 'facts.md', 'IMPORT.md', 'manifest.json'].concat(
      listFiles(pristine).filter((name) => name.startsWith('kb/') || name.startsWith('pages/')))
    for (const name of names) {
      const dir = caseDir(root, pristine, 'edit-' + name.replace(/[^a-zA-Z0-9]+/g, '-'))
      const file = join(dir, ...name.split('/'))
      const tampered = Buffer.from(readFileSync(file))
      tampered[tampered.length - 1] = tampered[tampered.length - 1] === 0x7a ? 0x7b : 0x7a
      writeFileSync(file, tampered)
      assertTampered(verifyBundleDir(dir), name)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
const NL = String.fromCharCode(10)

test('SHA256SUMS structure is strict (malformed/duplicate/self/unsafe/CRLF are invalid)', () => {
  const { root, home } = makeRoot('advisers-bundle-sums-')
  try {
    seedHome(home)
    const pristine = makeBundle(root, home)
    const sums = readFileSync(join(pristine, BUNDLE_SHA256SUMS_FILE), 'utf8')
    const cases = [
      ['malformed', (dir) => writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), 'not-a-line' + NL), /malformed|missing/],
      ['self', (dir) => writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), sums + sha256Hex(sums) + '  SHA256SUMS' + NL), /must not list itself|malformed/],
      ['duplicate', (dir) => { const first = sums.split(NL)[0]; writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), sums + first + NL) }, /duplicate/],
      ['unsafe', (dir) => writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), sums + sha256Hex('x') + '  ../evil' + NL), /unsafe path/],
      ['crlf', (dir) => writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), sums.replace(new RegExp(NL, 'g'), String.fromCharCode(13) + NL)), /CR|LF/],
    ]
    for (const [label, mutate, pattern] of cases) {
      const dir = caseDir(root, pristine, 'sums-' + label)
      mutate(dir)
      assertInvalid(verifyBundleDir(dir), 'sums ' + label, pattern)
    }
    const digestEdit = caseDir(root, pristine, 'sums-digest')
    const flipped = sums.split(NL)
    flipped[0] = (flipped[0].charAt(0) === '0' ? '1' : '0') + flipped[0].slice(1)
    writeFileSync(join(digestEdit, BUNDLE_SHA256SUMS_FILE), flipped.join(NL))
    assertTampered(verifyBundleDir(digestEdit), 'sums digest edit')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('extra files, unknown directories, symlinks and missing required files are refused', (t) => {
  const { root, home } = makeRoot('advisers-bundle-tree-')
  try {
    seedHome(home)
    const pristine = makeBundle(root, home)
    const extra = caseDir(root, pristine, 'extra-file')
    writeFileSync(join(extra, 'extra.txt'), 'x')
    assertInvalid(verifyBundleDir(extra), 'extra file', /unexpected file|not covered/)
    const extraDir = caseDir(root, pristine, 'extra-dir')
    mkdirSync(join(extraDir, 'notes'))
    writeFileSync(join(extraDir, 'notes', 'x.txt'), 'x')
    assertInvalid(verifyBundleDir(extraDir), 'extra dir', /unexpected directory/)
    const missing = caseDir(root, pristine, 'missing-import')
    rmSync(join(missing, 'IMPORT.md'))
    assertInvalid(verifyBundleDir(missing), 'missing IMPORT.md', /missing file|does not cover/)
    const missingLedger = caseDir(root, pristine, 'missing-ledger')
    rmSync(join(missingLedger, 'ledger.json'))
    assertInvalid(verifyBundleDir(missingLedger), 'missing ledger.json', /missing file/)
    const symlinked = caseDir(root, pristine, 'symlink')
    const made = symlinkOrSkip(t, join(symlinked, 'ledger.json'), join(symlinked, 'KB.md'), 'file')
    if (made) assertInvalid(verifyBundleDir(symlinked), 'symlink', /symbolic links/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('manifest schema/scalars are pinned and the dataDigest is recomputed', () => {
  const { root, home } = makeRoot('advisers-bundle-manifest-')
  try {
    seedHome(home)
    const pristine = makeBundle(root, home)
    const mutations = [
      ['format', (manifest) => { manifest.format = 'other' }, /manifest.format/],
      ['version', (manifest) => { manifest.version = 2 }, /manifest.version/],
      ['scope', (manifest) => { manifest.scope = 'client' }, /manifest.scope/],
      ['subject', (manifest) => { manifest.subject = { kind: 'client', id: 'cl_1', name: '王工' } }, /manifest.subject/],
      ['basis', (manifest) => { manifest.verificationBasis = 'signed' }, /verificationBasis/],
      ['schema-newer', (manifest) => { manifest.schemaVersion = SCHEMA_VERSION + 1 }, /newer than this CLI/],
      ['counts', (manifest) => { manifest.counts.clients = manifest.counts.clients + 1 }, /counts|ledger.data/],
      ['excluded', (manifest) => { manifest.excluded = manifest.excluded.filter((item) => item !== 'audit') }, /excluded/],
      ['disclaimer', (manifest) => { manifest.disclaimer = false }, /disclaimer/],
      ['dataDigest', (manifest) => { manifest.dataDigest = '0'.repeat(64) }, /dataDigest mismatch|sha256 disagrees/],
    ]
    for (const [label, mutate, pattern] of mutations) {
      const dir = caseDir(root, pristine, 'manifest-' + label)
      const manifestPath = join(dir, BUNDLE_MANIFEST_FILE)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      mutate(manifest)
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + NL)
      resealSums(dir)
      const result = verifyBundleDir(dir)
      assert.equal(result.ok, false, 'manifest ' + label + ' must fail')
      assert.match(result.errors.join(' | '), pattern, 'manifest ' + label + ' error: ' + result.errors[0])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ledger.json stays export --all compatible and never smuggles excluded tables', () => {
  const { root, home } = makeRoot('advisers-bundle-ledger-')
  try {
    seedHome(home)
    const pristine = makeBundle(root, home)
    const editLedger = (dir, mutate) => {
      const file = join(dir, 'ledger.json')
      const payload = JSON.parse(readFileSync(file, 'utf8'))
      mutate(payload)
      writeFileSync(file, JSON.stringify(payload, null, 2) + NL)
      resealManifestAndSums(dir)
    }
    const auditTable = caseDir(root, pristine, 'audit-table')
    editLedger(auditTable, (payload) => { payload.data.audit = [] })
    assertInvalid(verifyBundleDir(auditTable), 'audit table in data', /exactly the bundle data tables|excluded table/)
    const kbPagesTable = caseDir(root, pristine, 'kb-pages-table')
    editLedger(kbPagesTable, (payload) => { payload.data.kb_pages = [] })
    assertInvalid(verifyBundleDir(kbPagesTable), 'kb_pages table in data', /exactly the bundle data tables|excluded table/)
    const anchor = caseDir(root, pristine, 'anchor')
    editLedger(anchor, (payload) => { payload.auditAnchor = { format: 'advisers-audit-anchor' } })
    assertInvalid(verifyBundleDir(anchor), 'non-null auditAnchor', /auditAnchor must be null/)
    const digest = caseDir(root, pristine, 'digest')
    editLedger(digest, (payload) => { payload.data.clients[0].name = 'edited' })
    assertTampered(verifyBundleDir(digest), 'edited data row')
    // A bundle written by the previous schema: its own (smaller) dataDigest
    // domain is legitimate, so it verifies with warnings instead of failing.
    const older = caseDir(root, pristine, 'older-schema')
    const legacyTables = bundleDataTablesForSchema(SCHEMA_VERSION - 1)
    const olderLedgerPath = join(older, 'ledger.json')
    const olderPayload = JSON.parse(readFileSync(olderLedgerPath, 'utf8'))
    olderPayload.schemaVersion = SCHEMA_VERSION - 1
    for (const table of Object.keys(olderPayload.data)) if (!legacyTables.includes(table)) delete olderPayload.data[table]
    writeFileSync(olderLedgerPath, JSON.stringify(olderPayload, null, 2) + NL)
    const manifestPath = join(older, BUNDLE_MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.schemaVersion = SCHEMA_VERSION - 1
    manifest.tables = [...legacyTables]
    for (const table of Object.keys(manifest.counts)) if (!legacyTables.includes(table)) delete manifest.counts[table]
    manifest.dataDigest = computeBundleDataDigest(olderPayload.data, { tables: legacyTables }).dataDigest
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + NL)
    resealManifestAndSums(older)
    const olderResult = verifyBundleDir(older)
    assert.equal(olderResult.ok, true, JSON.stringify(olderResult.errors))
    assert.match(olderResult.warnings.join(' '), /older than this CLI/)
    assert.match(olderResult.warnings.join(' '), /predates v/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verification is zero-write and works without any HOME or ledger', () => {
  const { root, home } = makeRoot('advisers-bundle-zerowrite-')
  try {
    seedHome(home)
    const pristine = makeBundle(root, home)
    const fakeHome = join(root, 'no-such-home')
    const previousHome = process.env.ADVISERS_HOME
    process.env.ADVISERS_HOME = fakeHome
    try {
      const before = treeSnapshot(pristine)
      for (let index = 0; index < 3; index += 1) {
        const result = verifyBundleDir(pristine)
        assert.equal(result.ok, true, JSON.stringify(result.errors))
      }
      assert.deepEqual(treeSnapshot(pristine), before)
      assert.equal(existsSync(fakeHome), false, 'verification must not create ADVISERS_HOME')
    } finally {
      if (previousHome === undefined) delete process.env.ADVISERS_HOME
      else process.env.ADVISERS_HOME = previousHome
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('non-bundle inputs are rejected without throwing', () => {
  const { root } = makeRoot('advisers-bundle-notabundle-')
  try {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    assertInvalid(verifyBundleDir(empty), 'empty dir', /SHA256SUMS/)
    const file = join(root, 'file.txt')
    writeFileSync(file, 'x')
    assertInvalid(verifyBundleDir(file), 'file path', /not a directory/)
    assertInvalid(verifyBundleDir(join(root, 'missing')), 'missing dir', /not found/)
    assertInvalid(verifyBundleDir(''), 'empty path', /required/)
    const header = readBundleManifestHeader(empty)
    assert.equal(header.ok, false)
    assert.match(header.error, /manifest.json not found/)
    const real = join(root, 'half')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'manifest.json'), '{')
    assertInvalid(verifyBundleDir(real), 'broken/half bundle', /SHA256SUMS/)
    assert.equal(readBundleManifestHeader(real).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
