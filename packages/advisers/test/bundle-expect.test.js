import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseClientPackSums } from '../lib/client-pack.js'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import {
  BUNDLE_DATA_TABLES,
  BUNDLE_FORMAT_FILE,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SHA256SUMS_FILE,
  buildBundle,
  bundleDataTablesForSchema,
  compareBundleDirs,
  computeBundleDataDigest,
  exportBundle,
  importBundle,
  verifyBundleDir,
  writeBundleDir,
} from '../lib/bundle.js'

// 0.5.1 task-121: bundle acceptance UX + in-bundle FORMAT.md.
//
// - --expect-dataDigest / compareBundleDirs fail closed with E_BUNDLE_TAMPERED
//   and zero writes; the JSON carries expectedDigest + dataDigestMatch.
// - FORMAT.md is written by default, covered by SHA256SUMS/manifest.files and
//   deterministic; a legacy 0.5.0 bundle (no FORMAT.md) still verifies/imports
//   and compares equal to a 0.5.1 bundle of the same data.
// Every fixture is an mkdtemp() home; the real ~/.advisers is never touched.

const NOW = '2026-11-01T00:00:00.000Z'
const EXPORTED_AT = '2026-11-22T00:00:00.000Z'

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, home: join(root, 'home') }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function ledgerSnapshot(commitmentAction) {
  return {
    version: 1,
    matters: [{
      id: 'm1', title: 'Acceptance matter', status: 'active', domain: 'general', secrecy: 0,
      participants: ['王工'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW,
    }],
    facts: [{
      id: 'f1', matterId: 'm1', subject: '客户', predicate: '预算', object: '10 万',
      recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'active',
    }],
    commitments: [{
      id: 'cm_1', matterId: 'm1', debtor: 'user', creditor: '王工', action: commitmentAction,
      timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'quote', createdAt: NOW,
    }],
    preferences: [], links: [], updates: [], routes: { activeMatter: 'm1' }, routines: [], routinePatches: [],
  }
}

function seedHome(home, commitmentAction = '发送报价') {
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  store.saveWithAudit(ledgerSnapshot(commitmentAction), { actor: 'local', action: 'expect.seed', allowed: true, reason: null })
  // One client row so a mutation can change a DATA table (the dataDigest domain):
  // the ledger snapshot tables (matters/facts/commitments/...) are carried by
  // ledger.json, not by the data tables, and are not part of dataDigest v1.
  store.addClient({ name: '客户甲' })
  store.close()
  return home
}

function exportTo(home, outDir, extra = {}) {
  const exported = exportBundle({ home, outDir, generatedAt: EXPORTED_AT, ...extra })
  assert.equal(exported.ok, true, JSON.stringify(exported.errors))
  return exported
}


const V23_TABLES = ['handoff_claims', 'handoffs', 'waiting_replies']

function listFiles(root, relativeDir = '') {
  const out = []
  const dir = relativeDir ? join(root, ...relativeDir.split('/')) : root
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = relativeDir ? relativeDir + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...listFiles(root, relativePath))
    else out.push(relativePath)
  }
  return out.sort()
}

/** Recompute manifest.files/fileCount/checksumCount and SHA256SUMS from disk. */
function resealBundle(dir) {
  const manifestPath = join(dir, BUNDLE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const allNames = listFiles(dir).filter((name) => name !== BUNDLE_SHA256SUMS_FILE)
  const dataNames = allNames.filter((name) => name !== BUNDLE_MANIFEST_FILE)
  manifest.files = dataNames.map((name) => {
    const bytes = readFileSync(join(dir, ...name.split('/')))
    return { path: name, size: bytes.length, sha256: sha256Hex(bytes) }
  })
  manifest.fileCount = manifest.files.length
  manifest.checksumCount = manifest.files.length + 1
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10))
  const sums = allNames.map((name) => sha256Hex(readFileSync(join(dir, ...name.split('/')))) + '  ' + name).join(String.fromCharCode(10))
  writeFileSync(join(dir, BUNDLE_SHA256SUMS_FILE), sums + String.fromCharCode(10))
  return manifest
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

/**
 * Turn a v23 bundle into the layout/domain a 0.5.0 (schema v22) binary wrote:
 * no FORMAT.md, 20 data tables, dataDigest over that v22 domain. This models
 * the real 0.5.0 artifact without needing the old schema binary.
 */
function downgradeBundleToV22(dir) {
  const manifestPath = join(dir, BUNDLE_MANIFEST_FILE)
  const ledgerPath = join(dir, 'ledger.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  const legacyDomain = bundleDataTablesForSchema(22)
  manifest.schemaVersion = 22
  ledger.schemaVersion = 22
  manifest.tables = [...legacyDomain]
  for (const table of V23_TABLES) {
    delete manifest.counts[table]
    delete ledger.data[table]
  }
  const digest = computeBundleDataDigest(ledger.data, { tables: manifest.tables })
  manifest.dataDigest = digest.dataDigest
  rmSync(join(dir, BUNDLE_FORMAT_FILE))
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + String.fromCharCode(10))
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10))
  resealBundle(dir)
  return { manifest, ledger }
}

function mutateClient(home, nextName) {
  const store = new SqliteStore(join(home, 'state.db'))
  store.mutate(() => store.db.prepare('UPDATE clients SET name = ?').run(nextName))
  store.close()
}

test('verifyBundleDir --expect-dataDigest matches, mismatches and rejects malformed input', () => {
  const { root, home } = makeRoot('advisers-bundle-expect-')
  try {
    seedHome(home)
    const bundleDir = join(root, 'bundle')
    const exported = exportTo(home, bundleDir)
    const digest = exported.dataDigest
    assert.match(digest, /^[0-9a-f]{64}$/)

    const matched = verifyBundleDir(bundleDir, { expectDataDigest: digest })
    assert.equal(matched.ok, true, matched.errors.join(' | '))
    assert.equal(matched.expectedDigest, digest)
    assert.equal(matched.dataDigestMatch, true)
    assert.equal(matched.computedDataDigest, digest)

    // Uppercase is normalized, not rejected.
    const upper = verifyBundleDir(bundleDir, { expectDataDigest: digest.toUpperCase() })
    assert.equal(upper.ok, true)
    assert.equal(upper.dataDigestMatch, true)

    const wrongDigest = '0'.repeat(64)
    const mismatched = verifyBundleDir(bundleDir, { expectDataDigest: wrongDigest })
    assert.equal(mismatched.ok, false)
    assert.equal(mismatched.code, 'E_BUNDLE_TAMPERED')
    assert.equal(mismatched.expectedDigest, wrongDigest)
    assert.equal(mismatched.dataDigestMatch, false)
    assert.ok(mismatched.errors.some((message) => /does not match the expected digest/.test(message)), JSON.stringify(mismatched.errors))
    assert.ok(mismatched.errors.some((message) => message.includes(wrongDigest)), 'the error must show the expected digest')

    const malformed = verifyBundleDir(bundleDir, { expectDataDigest: 'not-hex' })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.dataDigestMatch, false)
    assert.ok(malformed.errors.some((message) => /64 lowercase hex/.test(message)))

    // Unchanged verification result for callers that do not pass an expectation.
    const plain = verifyBundleDir(bundleDir)
    assert.equal(plain.ok, true)
    assert.equal(plain.expectedDigest, null)
    assert.equal(plain.dataDigestMatch, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('importBundle --expect-dataDigest is zero-write on mismatch and reports match on success', () => {
  const { root, home } = makeRoot('advisers-bundle-expect-import-')
  try {
    seedHome(home)
    const bundleDir = join(root, 'bundle')
    const exported = exportTo(home, bundleDir)
    const digest = exported.dataDigest

    const wrongHome = join(root, 'home-wrong')
    const refused = importBundle({ bundleDir, home: wrongHome, expectDataDigest: 'f'.repeat(64) })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'E_BUNDLE_TAMPERED')
    assert.equal(refused.dataDigestMatch, false)
    assert.equal(refused.expectedDigest, 'f'.repeat(64))
    assert.equal(existsSync(wrongHome), false, 'a rejected expectation must not create the target home')

    const dryWrong = importBundle({ bundleDir, home: wrongHome, dryRun: true, expectDataDigest: 'f'.repeat(64) })
    assert.equal(dryWrong.ok, false)
    assert.equal(dryWrong.code, 'E_BUNDLE_TAMPERED')
    assert.equal(existsSync(wrongHome), false, 'a rejected dry-run must not create the target home')

    const dryOk = importBundle({ bundleDir, home: wrongHome, dryRun: true, expectDataDigest: digest })
    assert.equal(dryOk.ok, true, JSON.stringify(dryOk.errors))
    assert.equal(dryOk.dryRun, true)
    assert.equal(dryOk.expectedDigest, digest)
    assert.equal(dryOk.dataDigestMatch, true)
    assert.equal(existsSync(wrongHome), false, 'a successful dry-run is still zero write')

    const targetHome = join(root, 'home-target')
    const imported = importBundle({ bundleDir, home: targetHome, expectDataDigest: digest })
    assert.equal(imported.ok, true, JSON.stringify(imported.errors))
    assert.equal(imported.dataDigest, digest)
    assert.equal(imported.expectedDigest, digest)
    assert.equal(imported.dataDigestMatch, true)
    const reexport = exportTo(targetHome, join(root, 'bundle-target'))
    assert.equal(reexport.dataDigest, digest, 'dataDigest parity after a checked import')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('compareBundleDirs accepts equal data and reports a differing dataDigest', () => {
  const { root, home } = makeRoot('advisers-bundle-compare-')
  try {
    seedHome(home)
    const first = exportTo(home, join(root, 'bundle-a'))
    const legacy = exportTo(home, join(root, 'bundle-legacy'), { includeFormat: false })
    const same = compareBundleDirs(join(root, 'bundle-a'), join(root, 'bundle-a'))
    assert.equal(same.ok, true)
    assert.equal(same.match, true)
    assert.equal(same.code, null)
    assert.deepEqual(same.differences, [])
    assert.equal(same.a.dataDigest, first.dataDigest)

    // A legacy 0.5.0 layout carries the same data: compare says equal.
    const legacyVsNew = compareBundleDirs(join(root, 'bundle-a'), join(root, 'bundle-legacy'))
    assert.equal(legacyVsNew.ok, true, JSON.stringify(legacyVsNew.errors))
    assert.equal(legacyVsNew.match, true)
    assert.equal(legacyVsNew.b.dataDigest, first.dataDigest)

    mutateClient(home, '客户甲（改名）')
    const second = exportTo(home, join(root, 'bundle-b'))
    assert.notEqual(second.dataDigest, first.dataDigest)
    const changed = compareBundleDirs(join(root, 'bundle-a'), join(root, 'bundle-b'))
    assert.equal(changed.ok, false)
    assert.equal(changed.match, false)
    assert.equal(changed.code, 'E_BUNDLE_TAMPERED')
    assert.ok(changed.differences.some((entry) => entry.field === 'dataDigest'), JSON.stringify(changed.differences))
    assert.equal(changed.b.schemaVersion, changed.a.schemaVersion)

    const invalid = compareBundleDirs(join(root, 'bundle-a'), join(root, 'no-such-bundle'))
    assert.equal(invalid.ok, false)
    assert.equal(invalid.match, false)
    assert.equal(invalid.b.ok, false)
    assert.ok(invalid.errors.some((message) => /bundle B is not a valid bundle/.test(message)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('FORMAT.md is in the bundle, checksum-covered, deterministic and descriptive', () => {
  const { root, home } = makeRoot('advisers-bundle-format-')
  try {
    seedHome(home)
    const bundleDir = join(root, 'bundle')
    const exported = exportTo(home, bundleDir)
    const formatPath = join(bundleDir, BUNDLE_FORMAT_FILE)
    assert.ok(existsSync(formatPath), 'FORMAT.md must be written into the bundle')
    const formatText = readFileSync(formatPath, 'utf8')
    assert.equal(formatText.includes(String.fromCharCode(13)), false, 'FORMAT.md must use LF')
    assert.match(formatText, /# Advisers portable home bundle - FORMAT v1/)
    for (const needle of ['manifest.json', 'ledger.json', 'SHA256SUMS', 'dataDigest', 'canonicalize', 'clients', 'name', 'commitments', 'Minimal reader pseudocode', 'OPTIONAL in v1']) {
      assert.ok(formatText.includes(needle), 'FORMAT.md must describe ' + needle)
    }
    assert.ok(!formatText.includes(home), 'FORMAT.md must not leak absolute paths')
    assert.ok(!formatText.includes('王工'), 'FORMAT.md must not copy row values')

    const manifest = JSON.parse(readFileSync(join(bundleDir, BUNDLE_MANIFEST_FILE), 'utf8'))
    assert.ok(manifest.files.some((record) => record.path === BUNDLE_FORMAT_FILE), 'manifest.files must list FORMAT.md')
    assert.equal(manifest.files.find((record) => record.path === BUNDLE_FORMAT_FILE).sha256, sha256Hex(Buffer.from(formatText, 'utf8')))
    const sums = parseClientPackSums(readFileSync(join(bundleDir, BUNDLE_SHA256SUMS_FILE), 'utf8'))
    assert.deepEqual(sums.errors, [])
    assert.ok(sums.entries.has(BUNDLE_FORMAT_FILE), 'SHA256SUMS must cover FORMAT.md')
    assert.equal(sums.entries.get(BUNDLE_FORMAT_FILE), sha256Hex(Buffer.from(formatText, 'utf8')))
    assert.ok(readFileSync(join(bundleDir, 'IMPORT.md'), 'utf8').includes(BUNDLE_FORMAT_FILE), 'IMPORT.md must list FORMAT.md')
    assert.equal(exported.fileCount, manifest.files.length)
    assert.ok(manifest.files.some((record) => record.path === BUNDLE_FORMAT_FILE))

    // The FORMAT.md is a pure function of version/schema/data: two exports of the
    // same home at different times generate byte-identical FORMAT.md.
    const otherDir = join(root, 'bundle-other')
    const other = exportBundle({ home, outDir: otherDir, generatedAt: '2026-12-01T00:00:00.000Z' })
    assert.equal(other.ok, true)
    assert.deepEqual(readFileSync(join(otherDir, BUNDLE_FORMAT_FILE)), readFileSync(formatPath))

    const verified = verifyBundleDir(bundleDir)
    assert.equal(verified.ok, true)
    assert.ok(!verified.warnings.some((warning) => /has no FORMAT\.md/.test(warning)), 'a 0.5.1 bundle must not warn about a missing FORMAT.md')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a legacy 0.5.0 bundle without FORMAT.md still verifies, imports and compares equal', () => {
  const { root, home } = makeRoot('advisers-bundle-legacy-')
  try {
    seedHome(home)
    const built = buildBundle({ home, generatedAt: EXPORTED_AT, includeFormat: false })
    assert.equal(built.ok, true)
    assert.equal(built.files.has(BUNDLE_FORMAT_FILE), false)
    const legacyDir = join(root, 'legacy')
    writeBundleDir(legacyDir, built)
    assert.equal(existsSync(join(legacyDir, BUNDLE_FORMAT_FILE)), false)

    const verified = verifyBundleDir(legacyDir)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
    assert.ok(verified.warnings.some((warning) => /has no FORMAT\.md/.test(warning)), 'a legacy bundle should warn, not fail')

    const expected = verifyBundleDir(legacyDir)
    const matching = verifyBundleDir(legacyDir, { expectDataDigest: expected.dataDigest })
    assert.equal(matching.ok, true)
    assert.equal(matching.dataDigestMatch, true)

    const targetHome = join(root, 'home-target')
    const imported = importBundle({ bundleDir: legacyDir, home: targetHome })
    assert.equal(imported.ok, true, JSON.stringify(imported.errors))
    const reexport = exportTo(targetHome, join(root, 'reexport'))
    assert.equal(reexport.dataDigest, expected.dataDigest)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a 0.5.0 v22-domain bundle verifies, imports into v23 and compares on the shared domain', () => {
  const { root, home } = makeRoot('advisers-bundle-v22-')
  try {
    seedHome(home)
    const legacyDir = join(root, 'bundle-v22')
    exportTo(home, legacyDir)
    const downgraded = downgradeBundleToV22(legacyDir)
    assert.equal(downgraded.manifest.schemaVersion, 22)
    assert.deepEqual(downgraded.manifest.tables, bundleDataTablesForSchema(22))
    assert.equal(downgraded.manifest.tables.length < BUNDLE_DATA_TABLES.length, true, 'the v23 tables must not be in a v22 domain')
    for (const table of V23_TABLES) {
      assert.equal(table in downgraded.ledger.data, false)
      assert.equal(table in downgraded.manifest.counts, false)
    }

    // 1) verify: the legacy domain is accepted (warns, not fails).
    const verified = verifyBundleDir(legacyDir)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
    assert.equal(verified.schemaVersion, 22)
    assert.deepEqual(verified.tables, bundleDataTablesForSchema(22))
    assert.equal(verified.dataDigest, downgraded.manifest.dataDigest)
    assert.equal(verified.computedDataDigest, downgraded.manifest.dataDigest)
    assert.ok(verified.warnings.some((warning) => /predates v/.test(warning)), JSON.stringify(verified.warnings))
    assert.ok(verified.warnings.some((warning) => /imported empty/.test(warning)), JSON.stringify(verified.warnings))
    assert.equal(verifyBundleDir(legacyDir, { expectDataDigest: downgraded.manifest.dataDigest }).ok, true)
    assert.equal(verifyBundleDir(legacyDir, { expectDataDigest: '0'.repeat(64) }).ok, false)

    // 2) import into a clean v23 home: new tables are created empty, old data kept.
    const targetHome = join(root, 'home-target')
    const imported = importBundle({ bundleDir: legacyDir, home: targetHome })
    assert.equal(imported.ok, true, JSON.stringify(imported.errors))
    assert.equal(imported.schemaVersion, 22)
    assert.equal(imported.dataDigest, downgraded.manifest.dataDigest)
    assert.deepEqual(imported.tables, bundleDataTablesForSchema(22))
    const targetStore = new SqliteStore(join(targetHome, 'state.db'))
    try {
      for (const table of V23_TABLES) {
        const count = Number(targetStore.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n ?? 0)
        assert.equal(count, 0, table + ' must be imported empty from a v22 bundle')
      }
      assert.equal(Number(targetStore.db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get().n), downgraded.manifest.counts.kb_documents)
    } finally { targetStore.close() }

    // 3) re-export is a v23-domain bundle; the old tables keep their counts and the
    //    ledger snapshot survives byte-semantically (it is outside dataDigest).
    const v23Dir = join(root, 'bundle-v23')
    const reexport = exportTo(targetHome, v23Dir)
    assert.equal(reexport.schemaVersion, SCHEMA_VERSION)
    assert.ok(reexport.tables.includes('handoffs') && reexport.tables.includes('waiting_replies'))
    assert.notEqual(reexport.dataDigest, downgraded.manifest.dataDigest, 'a schema upgrade legitimately changes the dataDigest domain')
    for (const table of downgraded.manifest.tables) {
      assert.equal(reexport.counts[table], downgraded.manifest.counts[table], 'v22 count must survive the migration: ' + table)
    }
    const sourceLedger = JSON.parse(readFileSync(join(legacyDir, 'ledger.json'), 'utf8'))
    const targetLedger = JSON.parse(readFileSync(join(v23Dir, 'ledger.json'), 'utf8'))
    assert.deepEqual(canonical(targetLedger.ledger), canonical(sourceLedger.ledger), 'the ledger snapshot must round-trip across the schema upgrade')

    // 4) compareBundleDirs compares on the shared v22 domain and says match.
    const compared = compareBundleDirs(legacyDir, v23Dir)
    assert.equal(compared.ok, true, JSON.stringify(compared.errors))
    assert.equal(compared.match, true)
    assert.equal(compared.schemaVersionAdjusted, true)
    assert.deepEqual(compared.comparedTables, bundleDataTablesForSchema(22))
    assert.equal(compared.a.domainDigest, compared.b.domainDigest)
    assert.equal(compared.a.dataDigest, downgraded.manifest.dataDigest)
    assert.notEqual(compared.a.dataDigest, compared.b.dataDigest, 'the raw digests differ only by the schema domain')
    assert.deepEqual(compared.differences, [])

    // 5) strictness is not weakened: a legacy bundle may not silently drop a
    //    table that its own schemaVersion must carry.
    const brokenDir = join(root, 'bundle-v22-broken')
    cpSync(legacyDir, brokenDir, { recursive: true })
    const brokenManifest = JSON.parse(readFileSync(join(brokenDir, BUNDLE_MANIFEST_FILE), 'utf8'))
    const brokenLedger = JSON.parse(readFileSync(join(brokenDir, 'ledger.json'), 'utf8'))
    brokenManifest.tables = brokenManifest.tables.filter((table) => table !== 'clients')
    delete brokenManifest.counts.clients
    delete brokenLedger.data.clients
    brokenManifest.dataDigest = computeBundleDataDigest(brokenLedger.data, { tables: brokenManifest.tables }).dataDigest
    writeFileSync(join(brokenDir, BUNDLE_MANIFEST_FILE), JSON.stringify(brokenManifest, null, 2) + String.fromCharCode(10))
    writeFileSync(join(brokenDir, 'ledger.json'), JSON.stringify(brokenLedger, null, 2) + String.fromCharCode(10))
    resealBundle(brokenDir)
    const broken = verifyBundleDir(brokenDir)
    assert.equal(broken.ok, false)
    assert.ok(broken.errors.some((message) => /manifest\.tables must list the bundle data tables/.test(message)), JSON.stringify(broken.errors))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
