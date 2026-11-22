import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseClientPackSums } from '../lib/client-pack.js'
import { kbPageRebuild } from '../lib/kb-pages.js'
import { SCHEMA_VERSION, SqliteStore, openReadStore } from '../lib/sqlite.js'
import {
  BUNDLE_DATA_TABLES,
  BUNDLE_SHA256SUMS_FILE,
  buildBundle,
  computeBundleDataDigest,
  dataDigestForStore,
  exportBundle,
  verifyBundleDir,
} from '../lib/bundle.js'
import { assertPrivateMode } from './win-compat.mjs'

// 0.5.0 WF1 050-B1: bundle v1 build layout/manifest/SHA256SUMS/dataDigest,
// deterministic projections, read-only build, atomic export and the export
// target fence. Every fixture is a mkdtemp() home; the real ~/.advisers is
// never read or written.

const NOW = '2026-11-01T00:00:00.000Z'
const SHA = 'ab'.repeat(32)

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, home: join(root, 'home') }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function ledgerSnapshot() {
  return {
    version: 1,
    matters: [{
      id: 'm1', title: 'Smoke matter', status: 'active', domain: 'general', secrecy: 0,
      participants: ['王工'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW,
      clientId: 'cl_1', projectId: 'pj_1',
    }],
    facts: [{
      id: 'f1', matterId: 'm1', subject: '客户', predicate: '预算', object: '10 万',
      recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'active',
    }],
    commitments: [{
      id: 'cm_1', matterId: 'm1', debtor: 'user', creditor: '王工', action: '发送报价',
      timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'quote', createdAt: NOW,
    }],
    preferences: [], links: [], updates: [], routes: { activeMatter: 'm1' }, routines: [], routinePatches: [],
  }
}

/** Seed a realistic little home: ledger + customer/KB/mail/money data + pages. */
function seedHome(home) {
  mkdirSync(home, { recursive: true })
  const dbPath = join(home, 'state.db')
  const store = new SqliteStore(dbPath)
  store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'seed.ledger', allowed: true, reason: null })
  store.transaction(() => {
    store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('cl_1', '王工', '王工', '[]', 'active', '[]', 1, null, NOW, NOW)
    store.db.prepare('INSERT INTO projects(id,client_id,name,name_norm,status,started_at,due_at,default_matter_id,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('pj_1', 'cl_1', '年报项目', '年报项目', 'active', NOW, null, 'm1', null, NOW, NOW)
    store.db.prepare('INSERT INTO sessions(conversation_id,matter_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('cv_1', 'm1', '报价讨论', NOW, NOW)
    store.db.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
      .run('tr_1', 'cv_1', 1, 'user', '整理报价', NOW)
    store.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at,client_id,project_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('dv_1', 'm1', 'cv_1', '[]', 'quote', '报价 v1', null, NOW, 'cl_1', 'pj_1')
    store.db.prepare('INSERT INTO kb_documents(id,kind,title,client_id,project_id,matter_id,source_name,source_sha256,mime,size_bytes,encoding,extractor,status,secrecy,needs_ocr,truncated,text_bytes,chunk_count,safety,created_at,captured_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('kb_1', 'note', '会议纪要', 'cl_1', 'pj_1', 'm1', 'minutes.md', SHA, 'text/markdown', 42, 'utf8', 'local', 'active', 0, 0, 0, 12, 1, null, NOW, NOW, null)
    store.db.prepare('INSERT INTO kb_chunks(id,doc_id,seq,text,char_count) VALUES(?,?,?,?,?)')
      .run('kc_1', 'kb_1', 1, '会议纪要正文', 6)
    store.db.prepare('INSERT INTO kb_fact_links(fact_id,doc_id,chunk_id,relation,created_at) VALUES(?,?,?,?,?)')
      .run('f1', 'kb_1', 'kc_1', 'source', NOW)
    store.db.prepare('INSERT INTO mail_accounts(id,name,host,port,tls,username,mailbox,status,retention_days,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('ma_1', '工作邮箱', 'imap.example.com', 993, 'tls', 'wang@example.com', 'INBOX', 'active', 30, NOW, NOW)
    store.db.prepare('INSERT INTO mail_messages(id,account_id,mailbox,uid,dedupe_key,from_addr,subject,received_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('mm_1', 'ma_1', 'INBOX', 7, 'dd_1', 'wang@example.com', '报价确认', NOW, NOW, NOW)
    store.db.prepare('INSERT INTO receivables(id,commitment_id,client_id,project_id,matter_id,delivery_id,amount_minor,currency,kind,memo,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('rc_1', 'cm_1', 'cl_1', 'pj_1', 'm1', 'dv_1', 100000, 'CNY', 'quote', null, NOW, NOW)
    store.db.prepare('INSERT INTO payments(id,client_id,commitment_id,amount_minor,currency,paid_at,method,memo,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('pm_1', 'cl_1', 'cm_1', 50000, 'CNY', NOW, 'bank', null, NOW, NOW)
  })
  store.appendAudit({ actor: 'local', action: 'seed.audit', allowed: true, reason: null })
  kbPageRebuild(store, {})
  const digest = dataDigestForStore(store)
  store.close()
  return { home, dbPath, digest }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}


test('buildBundle writes the v1 layout, manifest and a strict SHA256SUMS', () => {
  const { root, home } = makeRoot('advisers-bundle-build-')
  try {
    const seeded = seedHome(home)
    const built = buildBundle({ home, generatedAt: '2026-11-22T00:00:00.000Z' })
    assert.equal(built.ok, true, JSON.stringify(built.errors))
    assert.equal(built.warnings.length, 0, JSON.stringify(built.warnings))
    const names = [...built.files.keys()].sort()
    for (const required of ['IMPORT.md', 'SHA256SUMS', 'facts.md', 'ledger.json', 'manifest.json', 'kb/kb_1.md']) {
      assert.ok(names.includes(required), 'missing ' + required + ' in ' + names.join(','))
    }
    assert.ok(names.some((name) => name.startsWith('pages/')), 'expected at least one pages/*.md projection')

    const manifest = built.manifest
    assert.equal(manifest.format, 'advisers-bundle')
    assert.equal(manifest.version, 1)
    assert.equal(manifest.scope, 'local-all')
    assert.equal(manifest.subject, null)
    assert.equal(manifest.verificationBasis, 'local-checksums-only')
    assert.equal(manifest.disclaimer, true)
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION)
    assert.equal(manifest.generatedAt, '2026-11-22T00:00:00.000Z')
    assert.equal(typeof manifest.generator.advisersVersion, 'string')
    assert.deepEqual(manifest.tables, [...BUNDLE_DATA_TABLES])
    assert.deepEqual(Object.keys(manifest.counts).sort(), [...BUNDLE_DATA_TABLES])
    assert.match(manifest.dataDigest, /^[0-9a-f]{64}$/)
    for (const table of ['audit', 'kb_pages']) assert.ok(manifest.excluded.includes(table), 'excluded must record ' + table)
    assert.equal(manifest.fileCount, manifest.files.length)
    assert.equal(manifest.checksumCount, manifest.fileCount + 1)
    assert.equal(manifest.files.some((record) => record.path === 'manifest.json'), false)
    assert.equal(manifest.files.some((record) => record.path === 'SHA256SUMS'), false)

    const sumsText = built.files.get(BUNDLE_SHA256SUMS_FILE).toString('utf8')
    assert.equal(sumsText.includes('\r'), false, 'SHA256SUMS must use LF')
    const parsed = parseClientPackSums(sumsText)
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.entries.size, manifest.checksumCount)
    assert.ok(parsed.entries.has('manifest.json'))
    assert.equal(parsed.entries.has(BUNDLE_SHA256SUMS_FILE), false)
    for (const [name, digest] of parsed.entries) {
      assert.equal(sha256Hex(built.files.get(name)), digest, 'SHA256SUMS digest mismatch for ' + name)
    }

    const ledgerJson = JSON.parse(built.files.get('ledger.json').toString('utf8'))
    assert.equal(typeof ledgerJson.version, 'string')
    assert.equal(ledgerJson.schemaVersion, SCHEMA_VERSION)
    assert.equal(ledgerJson.exportedAt, '2026-11-22T00:00:00.000Z')
    assert.equal(ledgerJson.auditAnchor, null)
    assert.equal(Array.isArray(ledgerJson.ledger.matters), true)
    assert.equal(ledgerJson.ledger.matters.length, 1)
    assert.equal(ledgerJson.sourceAudit.count, 3)
    assert.match(ledgerJson.sourceAudit.headHash, /^[0-9a-f]{64}$/)
    assert.deepEqual(Object.keys(ledgerJson.data).sort(), [...BUNDLE_DATA_TABLES])
    assert.equal(Object.prototype.hasOwnProperty.call(ledgerJson.data, 'audit'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(ledgerJson.data, 'kb_pages'), false)
    for (const table of BUNDLE_DATA_TABLES) {
      assert.equal(ledgerJson.data[table].length, manifest.counts[table], 'counts mismatch for ' + table)
    }
    assert.equal(ledgerJson.data.clients.length, 1)
    assert.equal(ledgerJson.data.kb_documents.length, 1)
    assert.equal(ledgerJson.data.receivables.length, 1)

    const recomputed = computeBundleDataDigest(ledgerJson.data)
    assert.equal(recomputed.dataDigest, manifest.dataDigest)
    assert.equal(recomputed.dataDigest, seeded.digest.dataDigest)
    assert.deepEqual(recomputed.counts, manifest.counts)

    const importMd = built.files.get('IMPORT.md').toString('utf8')
    assert.equal(importMd.includes('\r'), false)
    assert.ok(importMd.toLowerCase().includes('not a signature'))
    assert.ok(importMd.includes('SHA256SUMS'))
    assert.ok(importMd.includes(manifest.dataDigest))
    assert.ok(importMd.includes('advisers import --bundle'))
    assert.ok(importMd.includes('PLAINTEXT'))
  } finally { cleanup(root) }
})
test('build is deterministic: same home => same dataDigest/counts, only time fields differ', () => {
  const { root, home } = makeRoot('advisers-bundle-deterministic-')
  try {
    seedHome(home)
    const first = buildBundle({ home, generatedAt: '2026-11-22T00:00:00.000Z' })
    const second = buildBundle({ home, generatedAt: '2026-11-23T12:34:56.000Z' })
    assert.equal(first.ok, true, JSON.stringify(first.errors))
    assert.equal(second.ok, true, JSON.stringify(second.errors))
    assert.equal(first.summary.dataDigest, second.summary.dataDigest)
    assert.deepEqual(first.summary.counts, second.summary.counts)
    assert.deepEqual(first.summary.tables, second.summary.tables)
    // Projections are pure functions of the data: byte identical across runs.
    for (const name of [...first.files.keys()].filter((key) => key !== 'ledger.json' && key !== 'manifest.json' && key !== 'SHA256SUMS' && key !== 'IMPORT.md')) {
      assert.deepEqual(second.files.get(name), first.files.get(name), 'projection drifted: ' + name)
    }
    // ledger.json differs only in exportedAt; the data blocks are identical.
    const ledgerFirst = JSON.parse(first.files.get('ledger.json').toString('utf8'))
    const ledgerSecond = JSON.parse(second.files.get('ledger.json').toString('utf8'))
    assert.notEqual(ledgerFirst.exportedAt, ledgerSecond.exportedAt)
    ledgerFirst.exportedAt = ledgerSecond.exportedAt
    ledgerFirst.sourceAudit = ledgerSecond.sourceAudit
    assert.deepEqual(ledgerFirst, ledgerSecond)
    // manifest differs only in generatedAt (and the ledger.json file record hash).
    const manifestFirst = first.manifest
    const manifestSecond = second.manifest
    manifestFirst.generatedAt = manifestSecond.generatedAt
    manifestFirst.files = manifestSecond.files
    assert.deepEqual(manifestFirst, manifestSecond)
  } finally { cleanup(root) }
})

test('build is read-only: the database bytes and the home file set do not change', () => {
  const { root, home } = makeRoot('advisers-bundle-readonly-')
  try {
    const seeded = seedHome(home)
    const before = readFileSync(seeded.dbPath)
    const beforeNames = readdirSync(home).sort()
    const built = buildBundle({ home })
    assert.equal(built.ok, true, JSON.stringify(built.errors))
    assert.deepEqual(readFileSync(seeded.dbPath), before)
    assert.deepEqual(readdirSync(home).filter((name) => !name.startsWith('state.db')).sort(), beforeNames.filter((name) => !name.startsWith('state.db')).sort(), 'build must not create data files in the home (SQLite -wal/-shm read sidecars are not data)')
    assert.equal(readdirSync(home).some((name) => name.startsWith('bundle')), false)
  } finally { cleanup(root) }
})

test('build refuses a home without a SQLite database and a store without load()', () => {
  const { root, home } = makeRoot('advisers-bundle-nostore-')
  try {
    mkdirSync(home, { recursive: true })
    const missing = buildBundle({ home })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'E_BUNDLE_SQLITE_REQUIRED')
    const stub = buildBundle({ store: { exportDataTables: () => ({}) } })
    assert.equal(stub.ok, false)
    assert.equal(stub.code, 'E_BUNDLE_INVALID')
    const linked = buildBundle({ store: { db: { prepare: () => ({ all: () => [] }) }, load: () => null } })
    assert.equal(linked.ok, false)
    assert.equal(linked.code, 'E_BUNDLE_INVALID')
  } finally { cleanup(root) }
})

test('build projections mirror the data (facts/kb/pages markdown)', () => {
  const { root, home } = makeRoot('advisers-bundle-projections-')
  try {
    seedHome(home)
    const built = buildBundle({ home })
    assert.equal(built.ok, true, JSON.stringify(built.errors))
    const facts = built.files.get('facts.md').toString('utf8')
    assert.ok(facts.includes('10 万'))
    assert.ok(facts.includes('客户'))
    const kb = built.files.get('kb/kb_1.md').toString('utf8')
    assert.ok(kb.includes('会议纪要'))
    assert.ok(kb.includes('会议纪要正文'))
    assert.ok(kb.includes(SHA))
    const ledger = JSON.parse(built.files.get('ledger.json').toString('utf8'))
    assert.equal(ledger.data.kb_pages, undefined, 'kb_pages must not travel in ledger.json')
    const pages = [...built.files.keys()].filter((name) => name.startsWith('pages/'))
    assert.ok(pages.length >= 1)
    const store = new SqliteStore(join(home, 'state.db'))
    try {
      const row = store.db.prepare('SELECT id, markdown FROM kb_pages ORDER BY rowid').get()
      assert.ok(row, 'seeded home must have a kb_pages row')
      assert.equal(built.files.get('pages/' + row.id + '.md').toString('utf8'), row.markdown.endsWith('\n') ? row.markdown : row.markdown + '\n')
    } finally { store.close() }
  } finally { cleanup(root) }
})

test('build accepts an already-open read-only store, leaves it open, and records sourceAudit only', () => {
  const { root, home } = makeRoot('advisers-bundle-openstore-')
  try {
    const seeded = seedHome(home)
    const store = openReadStore(seeded.dbPath)
    try {
      const built = buildBundle({ store, generatedAt: '2026-11-22T00:00:00.000Z' })
      assert.equal(built.ok, true, JSON.stringify(built.errors))
      assert.equal(store.schemaVersion(), SCHEMA_VERSION, 'the caller store is still usable')
      const ledger = JSON.parse(built.files.get('ledger.json').toString('utf8'))
      assert.deepEqual(Object.keys(ledger.sourceAudit).sort(), ['count', 'headHash'])
      const auditRows = store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n
      assert.equal(ledger.sourceAudit.count, Number(auditRows))
    } finally { store.close() }
  } finally { cleanup(root) }
})

test('exportBundle writes the directory atomically, verifies it and sets private modes', () => {
  const { root, home } = makeRoot('advisers-bundle-export-')
  try {
    seedHome(home)
    const outDir = join(root, 'exports', 'bundle')
    const exported = exportBundle({ home, outDir, generatedAt: '2026-11-22T00:00:00.000Z' })
    assert.equal(exported.ok, true, JSON.stringify(exported.errors))
    assert.equal(exported.code, null)
    assert.equal(exported.out, outDir)
    assert.equal(exported.replaced, null)
    assert.equal(exported.format, 'advisers-bundle')
    assert.equal(exported.version, 1)
    assert.match(exported.dataDigest, /^[0-9a-f]{64}$/)
    assert.equal(exported.schemaVersion, SCHEMA_VERSION)
    assert.equal(exported.verification.ok, true, JSON.stringify(exported.verification.errors))
    assert.equal(existsSync(join(outDir, 'manifest.json')), true)
    assert.equal(existsSync(join(outDir, 'ledger.json')), true)
    assert.equal(existsSync(join(outDir, 'SHA256SUMS')), true)
    assert.equal(existsSync(join(outDir, 'IMPORT.md')), true)
    assertPrivateMode(outDir, 0o700, 'bundle directory')
    assertPrivateMode(join(outDir, 'ledger.json'), 0o600, 'ledger.json')
    assertPrivateMode(join(outDir, 'SHA256SUMS'), 0o600, 'SHA256SUMS')
    const again = exportBundle({ home, outDir: join(root, 'exports', 'bundle2'), generatedAt: '2026-11-22T00:00:00.000Z' })
    assert.equal(again.ok, true, JSON.stringify(again.errors))
    assert.equal(again.dataDigest, exported.dataDigest)
    assert.deepEqual(again.counts, exported.counts)
  } finally { cleanup(root) }
})

test('export target fence: non-empty target needs force, force renames the old tree, HOME is refused', () => {
  const { root, home } = makeRoot('advisers-bundle-target-')
  try {
    seedHome(home)
    const outDir = join(root, 'target')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'keep.txt'), 'keep me')
    const refused = exportBundle({ home, outDir })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'E_BUNDLE_TARGET')
    assert.equal(readFileSync(join(outDir, 'keep.txt'), 'utf8'), 'keep me')
    const forced = exportBundle({ home, outDir, force: true })
    assert.equal(forced.ok, true, JSON.stringify(forced.errors))
    assert.ok(forced.replaced, 'expected the old tree to be renamed aside')
    assert.equal(forced.replaced.startsWith(outDir + '.replaced-'), true)
    assert.equal(readFileSync(join(forced.replaced, 'keep.txt'), 'utf8'), 'keep me')
    assert.equal(existsSync(join(outDir, 'keep.txt')), false)
    assert.equal(existsSync(join(outDir, 'manifest.json')), true)
    for (const forbidden of [home, join(home, 'backups'), join(home, 'credentials'), join(home, 'scheduler')]) {
      const result = exportBundle({ home, outDir: forbidden })
      assert.equal(result.ok, false, 'expected ' + forbidden + ' to be refused')
      assert.equal(result.code, 'E_BUNDLE_TARGET')
    }
  } finally { cleanup(root) }
})

test('export accepts space/CJK/long output paths and rejects a missing directory or --encrypted', () => {
  const { root, home } = makeRoot('advisers-bundle-paths-')
  try {
    seedHome(home)
    const dirs = [
      join(root, '导出 目录 with space'),
      join(root, 'a'.repeat(90)),
    ]
    for (const outDir of dirs) {
      const exported = exportBundle({ home, outDir })
      assert.equal(exported.ok, true, JSON.stringify(exported.errors))
      assert.equal(verifyBundleDir(outDir).ok, true)
    }
    const missing = exportBundle({ home })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'E_BUNDLE_TARGET')
    const encrypted = exportBundle({ home, outDir: join(root, 'enc'), encrypted: true })
    assert.equal(encrypted.ok, false)
    assert.equal(encrypted.code, 'E_BUNDLE_PASSPHRASE')
    assert.equal(existsSync(join(root, 'enc')), false)
  } finally { cleanup(root) }
})
