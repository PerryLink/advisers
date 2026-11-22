import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { kbPageRebuild } from '../lib/kb-pages.js'
import { SCHEMA_VERSION, SqliteStore, openReadStore } from '../lib/sqlite.js'
import {
  BUNDLE_DATA_TABLES,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SHA256SUMS_FILE,
  computeBundleDataDigest,
  exportBundle,
  importBundle,
  verifyBundleDir,
} from '../lib/bundle.js'

// 0.5.0 WF1 050-B1/B3 (plaintext): clean-home bundle round-trip and the import
// failure matrix. Acceptance: H1 -> export -> clean H2 import -> dataDigest and
// counts equal; tamper/refusal paths write nothing; a pre-import managed backup
// exists when a local database already holds data. Temporary mkdtemp homes only.

const NOW = '2026-11-01T00:00:00.000Z'
const EXPORTED_AT = '2026-11-22T00:00:00.000Z'
const SHA = 'ab'.repeat(32)
const NL = String.fromCharCode(10)

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, home: join(root, 'source-home') }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function ledgerSnapshot() {
  return {
    version: 1,
    matters: [{ id: 'm1', title: 'Import smoke matter', status: 'active', domain: 'general', secrecy: 0, participants: ['王工'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: 'cl_1', projectId: 'pj_1' }],
    facts: [{ id: 'f1', matterId: 'm1', subject: '客户', predicate: '预算', object: '10 万', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'active' }],
    commitments: [{ id: 'cm_1', matterId: 'm1', debtor: 'user', creditor: '王工', action: '发送报价', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'quote', createdAt: NOW }],
    preferences: [], links: [], updates: [], routes: { activeMatter: 'm1' }, routines: [], routinePatches: [],
  }
}

function seedHome(home) {
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'import.seed.ledger', allowed: true, reason: null })
  store.transaction(() => {
    store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('cl_1', '王工', '王工', '[]', 'active', '[]', 1, null, NOW, NOW)
    store.db.prepare('INSERT INTO projects(id,client_id,name,name_norm,status,started_at,due_at,default_matter_id,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('pj_1', 'cl_1', '年报项目', '年报项目', 'active', NOW, null, 'm1', null, NOW, NOW)
    store.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at,client_id,project_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('dv_1', 'm1', 'cv_1', '[]', 'quote', '报价 v1', null, NOW, 'cl_1', 'pj_1')
    store.db.prepare('INSERT INTO kb_documents(id,kind,title,client_id,project_id,matter_id,source_name,source_sha256,size_bytes,extractor,status,secrecy,chunk_count,created_at,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('kb_1', 'note', '会议纪要', 'cl_1', 'pj_1', 'm1', 'minutes.md', SHA, 12, 'local', 'active', 0, 1, NOW, NOW)
    store.db.prepare('INSERT INTO kb_chunks(id,doc_id,seq,text,char_count) VALUES(?,?,?,?,?)')
      .run('kc_1', 'kb_1', 1, '会议纪要正文', 6)
    store.db.prepare('INSERT INTO receivables(id,commitment_id,client_id,project_id,matter_id,delivery_id,amount_minor,currency,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('rc_1', 'cm_1', 'cl_1', 'pj_1', 'm1', 'dv_1', 100000, 'CNY', 'quote', NOW, NOW)
    store.db.prepare('INSERT INTO payments(id,client_id,commitment_id,amount_minor,currency,paid_at,method,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('pm_1', 'cl_1', 'cm_1', 50000, 'CNY', NOW, 'bank', NOW, NOW)
  })
  store.appendAudit({ actor: 'local', action: 'import.seed.audit', allowed: true, reason: null })
  kbPageRebuild(store, {})
  const snapshot = {}
  for (const table of BUNDLE_DATA_TABLES) snapshot[table] = store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
  const digest = computeBundleDataDigest(snapshot)
  const pages = store.db.prepare('SELECT id FROM kb_pages ORDER BY rowid').all().map((row) => row.id)
  const auditActions = store.db.prepare('SELECT action FROM audit ORDER BY seq').all().map((row) => row.action)
  store.close()
  return { home, dbPath: join(home, 'state.db'), snapshot, digest, pages, auditActions }
}

function dataTablesOf(dbPath) {
  const store = openReadStore(dbPath)
  try {
    const snapshot = {}
    for (const table of BUNDLE_DATA_TABLES) snapshot[table] = store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
    return snapshot
  } finally { store.close() }
}

function makeBundle(root, home) {
  const pristine = join(root, 'pristine-bundle')
  const exported = exportBundle({ home, outDir: pristine, generatedAt: EXPORTED_AT })
  assert.equal(exported.ok, true, JSON.stringify(exported.errors))
  return { dir: pristine, exported }
}

function copyBundle(root, pristine, name) {
  const dir = join(root, 'bundle-' + name)
  cpSync(pristine, dir, { recursive: true })
  return dir
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

function resealManifestAndSums(dir) {
  const manifestPath = join(dir, BUNDLE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const records = listFiles(dir)
    .filter((name) => name !== BUNDLE_MANIFEST_FILE && name !== BUNDLE_SHA256SUMS_FILE)
    .map((name) => ({ path: name, size: statSync(join(dir, ...name.split('/'))).size, sha256: sha256Hex(readFileSync(join(dir, ...name.split('/')))) }))
  manifest.files = records
  manifest.fileCount = records.length
  manifest.checksumCount = records.length + 1
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + NL)
  const lines = listFiles(dir).filter((name) => name !== BUNDLE_SHA256SUMS_FILE)
    .map((name) => sha256Hex(readFileSync(join(dir, ...name.split('/')))) + '  ' + name)
  writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), lines.join(NL) + NL)
  return manifest
}

function tamperBundleLedger(dir) {
  const file = join(dir, 'ledger.json')
  const bytes = readFileSync(file)
  const tampered = Buffer.from(bytes)
  tampered[tampered.length - 1] = tampered[tampered.length - 1] === 0x7a ? 0x7b : 0x7a
  writeFileSync(file, tampered)
}
test('clean home import: H1 -> bundle -> empty H2 round-trips dataDigest/counts and rebuilds pages', () => {
  const { root, home } = makeRoot('advisers-bundle-roundtrip-')
  try {
    const source = seedHome(home)
    const { dir, exported } = makeBundle(root, home)
    const targetHome = join(root, 'target-home')
    assert.equal(existsSync(targetHome), false, 'the clean target home must not exist before import')

    const imported = importBundle({ home: targetHome, bundleDir: dir })
    assert.equal(imported.ok, true, JSON.stringify(imported.errors))
    assert.equal(imported.dryRun, false)
    assert.equal(imported.bootstrap, true)
    assert.equal(imported.replaceRequired, false)
    assert.equal(imported.backup, null, 'a clean home bootstrap has no database to back up')
    assert.equal(imported.rolledBack, false)
    assert.equal(imported.dataDigest, exported.dataDigest)
    assert.deepEqual(imported.counts, exported.counts)
    assert.equal(imported.schemaVersion, SCHEMA_VERSION)
    assert.equal(imported.verification.ok, true)
    assert.equal(imported.syncStateCleared, false)
    assert.ok(imported.pagesRebuilt > 0, 'expected kb_pages to be rebuilt')
    assert.equal(imported.restored.ftsRebuilt, true)
    assert.equal(imported.ftsRebuilt, true, 'top-level ftsRebuilt is part of the bin JSON contract')
    assert.equal(existsSync(join(targetHome, 'state.db')), true)

    const targetRows = dataTablesOf(join(targetHome, 'state.db'))
    const targetDigest = computeBundleDataDigest(targetRows)
    assert.equal(targetDigest.dataDigest, source.digest.dataDigest)
    assert.deepEqual(targetDigest.counts, source.digest.counts)
    for (const table of BUNDLE_DATA_TABLES) {
      assert.equal(imported.restored.tables[table], targetRows[table].length, 'restored row count for ' + table)
      assert.deepEqual(targetRows[table], source.snapshot[table], 'data row drift for ' + table)
    }

    const targetStore = new SqliteStore(join(targetHome, 'state.db'))
    try {
      assert.equal(targetStore.schemaVersion(), SCHEMA_VERSION)
      const ledger = targetStore.load()
      assert.equal(ledger.matters.length, 1)
      assert.equal(ledger.facts.length, 1)
      assert.equal(ledger.commitments.length, 1)
      assert.equal(targetStore.verifyAudit().ok, true, 'the local audit chain stays valid after import')
      const targetAuditActions = targetStore.db.prepare('SELECT action FROM audit ORDER BY seq').all().map((row) => row.action)
      assert.equal(targetAuditActions.includes('import.seed.ledger'), false, 'source audit rows must not travel')
      assert.equal(targetAuditActions.includes('import.bundle'), true)
      const targetPages = targetStore.db.prepare('SELECT id FROM kb_pages ORDER BY rowid').all().map((row) => row.id)
      assert.deepEqual(targetPages, source.pages, 'kb_pages is rebuilt deterministically from the imported data')
    } finally { targetStore.close() }

    const secondOut = join(root, 'second-export')
    const second = exportBundle({ home: targetHome, outDir: secondOut, generatedAt: '2026-11-23T00:00:00.000Z' })
    assert.equal(second.ok, true, JSON.stringify(second.errors))
    assert.equal(second.dataDigest, exported.dataDigest, 'the second export digest must equal the first')
    assert.deepEqual(second.counts, exported.counts)
    const verified = verifyBundleDir(secondOut)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('import --dry-run verifies and plans with zero writes (no HOME creation)', () => {
  const { root, home } = makeRoot('advisers-bundle-dryrun-')
  try {
    seedHome(home)
    const { dir, exported } = makeBundle(root, home)
    const targetHome = join(root, 'dry-home')
    const plan = importBundle({ home: targetHome, bundleDir: dir, dryRun: true })
    assert.equal(plan.ok, true, JSON.stringify(plan.errors))
    assert.equal(plan.dryRun, true)
    assert.equal(plan.bootstrap, true)
    assert.equal(plan.replaceRequired, false)
    assert.equal(plan.dataDigest, exported.dataDigest)
    assert.deepEqual(plan.counts, exported.counts)
    assert.equal(existsSync(targetHome), false, 'dry-run must not create the target home')
    assert.equal(existsSync(join(root, 'dry-home')), false)

    const existing = join(root, 'existing-home')
    mkdirSync(existing, { recursive: true })
    const store = new SqliteStore(join(existing, 'state.db'))
    store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'existing.seed', allowed: true, reason: null })
    store.close()
    const before = readFileSync(join(existing, 'state.db'))
    const blocked = importBundle({ home: existing, bundleDir: dir, dryRun: true })
    assert.equal(blocked.ok, true)
    assert.equal(blocked.replaceRequired, true, 'dry-run must report that --replace is required')
    assert.deepEqual(readFileSync(join(existing, 'state.db')), before)
    assert.equal(existsSync(join(existing, 'backups')), false, 'dry-run must not take a backup')

    const tampered = copyBundle(root, dir, 'tampered-dry')
    tamperBundleLedger(tampered)
    const refused = importBundle({ home: join(root, 'never-created'), bundleDir: tampered, dryRun: true })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'E_BUNDLE_TAMPERED')
    assert.equal(existsSync(join(root, 'never-created')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('a non-empty local database refuses import without replace and writes nothing', () => {
  const { root, home } = makeRoot('advisers-bundle-nonempty-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const targetHome = join(root, 'busy-home')
    mkdirSync(targetHome, { recursive: true })
    const store = new SqliteStore(join(targetHome, 'state.db'))
    store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'existing.ledger', allowed: true, reason: null })
    store.transaction(() => {
      store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('cl_existing', '李总', '李总', '[]', 'active', '[]', 0, null, NOW, NOW)
    })
    store.close()
    const before = readFileSync(join(targetHome, 'state.db'))
    const refused = importBundle({ home: targetHome, bundleDir: dir })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'E_BUNDLE_TARGET')
    assert.match(refused.errors.join(' '), /replace/)
    assert.equal(refused.rolledBack, false)
    assert.equal(refused.backup, null)
    assert.deepEqual(readFileSync(join(targetHome, 'state.db')), before, 'the local database bytes must not change')
    assert.equal(existsSync(join(targetHome, 'backups')), false, 'no backup is taken for a refused import')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('import --replace takes a fail-closed pre-import managed backup and replaces the local data', () => {
  const { root, home } = makeRoot('advisers-bundle-replace-')
  try {
    const source = seedHome(home)
    const { dir, exported } = makeBundle(root, home)
    const targetHome = join(root, 'replace-home')
    mkdirSync(targetHome, { recursive: true })
    const store = new SqliteStore(join(targetHome, 'state.db'))
    store.saveWithAudit({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routes: {}, routines: [], routinePatches: [] }, { actor: 'local', action: 'old.local', allowed: true, reason: null })
    store.transaction(() => {
      store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('cl_old', '旧客户', '旧客户', '[]', 'active', '[]', 0, null, NOW, NOW)
    })
    store.close()
    const imported = importBundle({ home: targetHome, bundleDir: dir, replace: true })
    assert.equal(imported.ok, true, JSON.stringify(imported.errors))
    assert.equal(imported.bootstrap, false)
    assert.equal(imported.replaced, true)
    assert.ok(imported.backup, 'expected a pre-import managed backup')
    assert.equal(imported.backup.ok, true)
    assert.equal(existsSync(imported.backup.path), true)
    assert.match(imported.backup.path.split(/[\\/]/).join('/'), /\/backups\/state-.*-pre-import\.db$/)
    assert.ok(imported.backup.path.endsWith('.sha256') === false)
    const backupSha = imported.backup.sidecars?.sha256
    const backupAnchor = imported.backup.sidecars?.anchor
    assert.equal(typeof backupSha, 'string')
    assert.equal(existsSync(backupSha), true)
    assert.equal(existsSync(backupAnchor), true)
    assert.equal(imported.dataDigest, exported.dataDigest)

    const rows = dataTablesOf(join(targetHome, 'state.db'))
    assert.equal(rows.clients.some((row) => row.name === '旧客户'), false, 'the old local data was replaced')
    assert.equal(rows.clients.some((row) => row.name === '王工'), true)
    assert.deepEqual(computeBundleDataDigest(rows).counts, source.digest.counts)
    const verify = new SqliteStore(join(targetHome, 'state.db'))
    try { assert.equal(verify.verifyAudit().ok, true) } finally { verify.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed pre-import backup aborts the import and leaves the database untouched', () => {
  const { root, home } = makeRoot('advisers-bundle-backupfail-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const targetHome = join(root, 'backup-fail-home')
    mkdirSync(targetHome, { recursive: true })
    const store = new SqliteStore(join(targetHome, 'state.db'))
    store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'existing.ledger', allowed: true, reason: null })
    store.close()
    writeFileSync(join(targetHome, 'backups'), 'not a directory')
    const before = readFileSync(join(targetHome, 'state.db'))
    const imported = importBundle({ home: targetHome, bundleDir: dir, replace: true })
    assert.equal(imported.ok, false)
    assert.equal(imported.code, 'E_BUNDLE_IMPORT_BACKUP')
    assert.equal(imported.rolledBack, false, 'nothing was written, so no rollback was needed')
    assert.deepEqual(readFileSync(join(targetHome, 'state.db')), before, 'the fail-closed backup must not touch the database')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a tampered bundle is refused before any write (no backup, no HOME, unchanged bytes)', () => {
  const { root, home } = makeRoot('advisers-bundle-import-tamper-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const targetHome = join(root, 'tamper-target')
    mkdirSync(targetHome, { recursive: true })
    const store = new SqliteStore(join(targetHome, 'state.db'))
    store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'existing.ledger', allowed: true, reason: null })
    store.close()
    const before = readFileSync(join(targetHome, 'state.db'))
    const tampered = copyBundle(root, dir, 'tamper-entry')
    tamperBundleLedger(tampered)
    const imported = importBundle({ home: targetHome, bundleDir: tampered, replace: true })
    assert.equal(imported.ok, false)
    assert.equal(imported.code, 'E_BUNDLE_TAMPERED')
    assert.equal(imported.backup, null)
    assert.deepEqual(readFileSync(join(targetHome, 'state.db')), before)
    assert.equal(existsSync(join(targetHome, 'backups')), false)
    assert.equal(existsSync(join(root, 'bundle-tamper-entry')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('import with an already-open store reuses it, takes a backup for an existing empty DB and leaves it open', () => {
  const { root, home } = makeRoot('advisers-bundle-openstore-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const targetHome = join(root, 'openstore-home')
    mkdirSync(targetHome, { recursive: true })
    const store = new SqliteStore(join(targetHome, 'state.db'))
    try {
      const imported = importBundle({ home: targetHome, bundleDir: dir, store })
      assert.equal(imported.ok, true, JSON.stringify(imported.errors))
      assert.equal(imported.bootstrap, true, 'a schema-only database is a bootstrap target')
      assert.ok(imported.backup, 'an existing (even empty) database gets a pre-import backup')
      assert.equal(existsSync(imported.backup.path), true)
      assert.equal(store.load().matters.length, 1, 'the caller store is still usable and holds the imported ledger')
      assert.equal(store.verifyAudit().ok, true)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a row the target schema cannot store rolls the whole transaction back and keeps the backup', () => {
  const { root, home } = makeRoot('advisers-bundle-rollback-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const broken = copyBundle(root, dir, 'broken-row')
    const ledgerFile = join(broken, 'ledger.json')
    const payload = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    payload.data.clients[0].unknown_bundle_column = 'boom'
    writeFileSync(ledgerFile, JSON.stringify(payload, null, 2) + NL)
    const digest = computeBundleDataDigest(payload.data)
    const manifestPath = join(broken, BUNDLE_MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dataDigest = digest.dataDigest
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + NL)
    resealManifestAndSums(broken)
    const verified = verifyBundleDir(broken)
    assert.equal(verified.ok, true, 'the structurally consistent bundle passes offline verification: ' + JSON.stringify(verified.errors))

    const targetHome = join(root, 'rollback-home')
    mkdirSync(targetHome, { recursive: true })
    const store = new SqliteStore(join(targetHome, 'state.db'))
    store.saveWithAudit(ledgerSnapshot(), { actor: 'local', action: 'existing.ledger', allowed: true, reason: null })
    store.transaction(() => {
      store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('cl_before', '保留客户', '保留客户', '[]', 'active', '[]', 0, null, NOW, NOW)
    })
    store.close()
    const imported = importBundle({ home: targetHome, bundleDir: broken, replace: true })
    assert.equal(imported.ok, false)
    assert.equal(imported.code, 'E_BUNDLE_INVALID')
    assert.equal(imported.rolledBack, true)
    assert.ok(imported.backup, 'the pre-import backup is kept even when the import rolls back')
    const check = new SqliteStore(join(targetHome, 'state.db'))
    try {
      assert.equal(check.verifyAudit().ok, true)
      const clients = check.db.prepare('SELECT name FROM clients ORDER BY rowid').all().map((row) => row.name)
      assert.deepEqual(clients, ['保留客户'], 'the rollback restores the original data')
      assert.equal(check.load().matters.length, 1)
    } finally { check.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('import clears sync.state.json and respects rebuildPages', () => {
  const { root, home } = makeRoot('advisers-bundle-sidefx-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const targetHome = join(root, 'sync-state-home')
    mkdirSync(targetHome, { recursive: true })
    writeFileSync(join(targetHome, 'sync.state.json'), JSON.stringify({ version: 1 }) + NL)
    const imported = importBundle({ home: targetHome, bundleDir: dir })
    assert.equal(imported.ok, true, JSON.stringify(imported.errors))
    assert.equal(imported.syncStateCleared, true)
    assert.equal(existsSync(join(targetHome, 'sync.state.json')), false)

    const noPagesHome = join(root, 'no-pages-home')
    const noPages = importBundle({ home: noPagesHome, bundleDir: dir, rebuildPages: false })
    assert.equal(noPages.ok, true, JSON.stringify(noPages.errors))
    assert.equal(noPages.pagesRebuilt, 0)
    const check = new SqliteStore(join(noPagesHome, 'state.db'))
    try {
      assert.equal(Number(check.db.prepare('SELECT COUNT(*) AS n FROM kb_pages').get().n), 0, 'derived pages are cleared and left for a manual rebuild')
    } finally { check.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('import refuses verification bypass and a bundle from a newer schema without writing', () => {
  const { root, home } = makeRoot('advisers-bundle-newer-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const targetHome = join(root, 'never-written')
    const bypass = importBundle({ home: targetHome, bundleDir: dir, verify: false })
    assert.equal(bypass.ok, false)
    assert.equal(bypass.code, 'E_BUNDLE_INVALID')
    assert.match(bypass.errors.join(' '), /refusing to import without verification/)
    assert.equal(existsSync(targetHome), false)

    const newer = copyBundle(root, dir, 'newer')
    const manifestPath = join(newer, BUNDLE_MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.schemaVersion = SCHEMA_VERSION + 1
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + NL)
    const lines = listFiles(newer).filter((name) => name !== BUNDLE_SHA256SUMS_FILE)
      .map((name) => sha256Hex(readFileSync(join(newer, ...name.split('/')))) + '  ' + name)
    writeFileSync(join(newer, BUNDLE_SHA256SUMS_FILE), lines.join(NL) + NL)
    const refused = importBundle({ home: targetHome, bundleDir: newer })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'E_BUNDLE_INVALID')
    assert.equal(existsSync(targetHome), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('the JSON store is refused for bundle export/import without creating a database', () => {
  const { root, home } = makeRoot('advisers-bundle-jsonstore-')
  try {
    seedHome(home)
    const { dir } = makeBundle(root, home)
    const jsonHome = join(root, 'json-home')
    mkdirSync(jsonHome, { recursive: true })
    writeFileSync(join(jsonHome, 'state.json'), JSON.stringify({ version: 1, matters: [] }) + NL)
    const imported = importBundle({ home: jsonHome, bundleDir: dir })
    assert.equal(imported.ok, false)
    assert.equal(imported.code, 'E_BUNDLE_SQLITE_REQUIRED')
    assert.match(imported.errors.join(' '), /JSON store/)
    assert.equal(existsSync(join(jsonHome, 'state.db')), false, 'no SQLite database is created for a JSON home')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
