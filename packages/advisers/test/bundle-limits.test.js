import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { kbPageRebuild } from '../lib/kb-pages.js'
import { DATA_TABLES, SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import {
  BUNDLE_DATA_TABLES,
  BUNDLE_LIMIT_CODE,
  buildBundle,
  exportBundle,
  isBundleLayoutPath,
  isUnsafeBundlePath,
  verifyBundleDir,
  writeBundleDir,
} from '../lib/bundle.js'
import { symlinkOrSkip } from './win-compat.mjs'

// 0.5.0 WF1 050-B2w/B2: bundle v1 resource limits (4096 entries / depth 4 /
// 512 MiB single file / 2 GiB total / 2 MiB SHA256SUMS) and the path fence
// (absolute/backslash/traversal/Windows reserved names/relative >120).

const NOW = '2026-11-01T00:00:00.000Z'
const SHA = 'ab'.repeat(32)

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, home: join(root, 'home') }
}

function seedHome(home) {
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  store.saveWithAudit({
    version: 1,
    matters: [{ id: 'm1', title: 'Limits matter', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW }],
    facts: [{ id: 'f1', matterId: 'm1', subject: '客户', predicate: '预算', object: '10 万', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'active' }],
    commitments: [], preferences: [], links: [], updates: [], routes: {}, routines: [], routinePatches: [],
  }, { actor: 'local', action: 'limits.seed', allowed: true, reason: null })
  store.transaction(() => {
    store.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('cl_1', '王工', '王工', '[]', 'active', '[]', 1, null, NOW, NOW)
    store.db.prepare('INSERT INTO kb_documents(id,kind,title,client_id,source_name,source_sha256,size_bytes,extractor,status,secrecy,chunk_count,created_at,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('kb_1', 'note', '限额明细', 'cl_1', 'minutes.md', SHA, 10, 'local', 'active', 0, 1, NOW, NOW)
    store.db.prepare('INSERT INTO kb_chunks(id,doc_id,seq,text,char_count) VALUES(?,?,?,?,?)')
      .run('kc_1', 'kb_1', 1, '限额明细正文', 6)
  })
  kbPageRebuild(store, {})
  store.close()
}

function makeBundle(root, home) {
  const outDir = join(root, 'bundle')
  const exported = exportBundle({ home, outDir, generatedAt: '2026-11-22T00:00:00.000Z' })
  assert.equal(exported.ok, true, JSON.stringify(exported.errors))
  return outDir
}
test('the dataDigest domain is DATA_TABLES minus audit/kb_pages, sorted and counted', () => {
  assert.equal(BUNDLE_DATA_TABLES.length, DATA_TABLES.length - 2)
  assert.equal(BUNDLE_DATA_TABLES.includes('audit'), false)
  assert.equal(BUNDLE_DATA_TABLES.includes('kb_pages'), false)
  assert.deepEqual([...BUNDLE_DATA_TABLES], [...BUNDLE_DATA_TABLES].sort())
  for (const table of ['clients', 'projects', 'kb_documents', 'mail_accounts', 'receivables', 'payments']) {
    assert.ok(BUNDLE_DATA_TABLES.includes(table), 'expected ' + table + ' in the digest domain')
  }
})

test('path fence: absolute/backslash/traversal/drive/reserved/invalid characters are unsafe', () => {
  for (const good of ['ledger.json', 'manifest.json', 'facts.md', 'IMPORT.md', 'SHA256SUMS', 'kb/kb_1.md', 'pages/page_client_cl_1.md', 'kb/会议纪要.md']) {
    assert.equal(isUnsafeBundlePath(good), false, 'expected safe: ' + good)
    assert.equal(isBundleLayoutPath(good), true, 'expected layout path: ' + good)
  }
  const bad = [
    '', '/abs/path', 'C:/x', 'C:' + String.fromCharCode(92) + 'x', 'a' + String.fromCharCode(92) + 'b',
    'a/../b', 'a/..', 'a/.', 'a//b', 'kb/', '../x', 'CON', 'con.md', 'aux', 'NUL.txt', 'COM1', 'lpt9.md',
    'a.', 'a ', 'a:b', 'a|b', 'a?b', 'a*b', 'a'.repeat(121), 'kb/' + 'x'.repeat(120), 'a/b/c/d/e',
    'a' + String.fromCharCode(9) + 'b', String.fromCharCode(0) + 'x',
  ]
  for (const name of bad) assert.equal(isUnsafeBundlePath(name), true, 'expected unsafe: ' + JSON.stringify(name))
  assert.equal(isBundleLayoutPath('notes.md'), false)
  assert.equal(isBundleLayoutPath('kb'), false)
  assert.equal(isBundleLayoutPath('kb/'), false)
  assert.equal(isBundleLayoutPath('other/x.md'), false)
  assert.equal(isBundleLayoutPath('pages/page.md'), true)
})

test('verify enforces every bundle v1 resource limit with E_BUNDLE_LIMIT metadata', () => {
  const { root, home } = makeRoot('advisers-bundle-limits-')
  try {
    seedHome(home)
    const dir = makeBundle(root, home)
    const cases = [
      ['maxEntries', 1],
      ['maxDepth', 0],
      ['maxFileBytes', 16],
      ['maxTotalBytes', 16],
      ['maxSumsBytes', 16],
      ['maxManifestBytes', 16],
      ['maxLedgerBytes', 16],
      ['maxImportBytes', 16],
      ['maxFactsBytes', 16],
    ]
    for (const [limit, value] of cases) {
      const result = verifyBundleDir(dir, { limits: { [limit]: value } })
      assert.equal(result.ok, false, limit + ' should trip')
      assert.equal(result.code, BUNDLE_LIMIT_CODE, limit + ' code: ' + result.code + ' / ' + JSON.stringify(result.errors.slice(0, 3)))
      assert.equal(result.limitViolation?.limit, limit, limit + ' structured limitViolation')
    }
    const custom = verifyBundleDir(dir, { limits: { maxEntries: 1 } })
    assert.equal(custom.limitViolation.code, BUNDLE_LIMIT_CODE)
    assert.equal(custom.limitViolation.max, 1)
    assert.equal(typeof custom.limitViolation.actual, 'number')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('build refuses its own limits before writing anything', () => {
  const { root, home } = makeRoot('advisers-bundle-buildlimits-')
  try {
    seedHome(home)
    for (const limits of [{ maxEntries: 1 }, { maxFileBytes: 16 }, { maxTotalBytes: 16 }]) {
      const built = buildBundle({ home, limits })
      assert.equal(built.ok, false, JSON.stringify(limits))
      assert.equal(built.code, BUNDLE_LIMIT_CODE, JSON.stringify(limits) + ': ' + built.code)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('writeBundleDir refuses unsafe file names in the in-memory file map', () => {
  const { root } = makeRoot('advisers-bundle-unsafe-')
  try {
    const cases = ['a/../evil.md', '/abs/evil.md', 'kb/..', 'notes/evil.md', 'evil' + String.fromCharCode(92) + 'x.md']
    for (const name of cases) {
      const built = { manifest: { format: 'advisers-bundle' }, files: new Map([[name, Buffer.from('x')]]) }
      assert.throws(
        () => writeBundleDir(join(root, 'out-' + Math.random().toString(16).slice(2)), built),
        /E_BUNDLE_INVALID|unsafe bundle path/,
        'expected refusal for ' + JSON.stringify(name),
      )
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('export refuses a symlinked target directory', (t) => {
  const { root, home } = makeRoot('advisers-bundle-symlink-target-')
  try {
    seedHome(home)
    const real = join(root, 'real-target')
    mkdirSync(real, { recursive: true })
    const link = join(root, 'link-target')
    const made = symlinkOrSkip(t, real, link, 'dir')
    if (!made) return
    const exported = exportBundle({ home, outDir: link })
    assert.equal(exported.ok, false)
    assert.equal(exported.code, 'E_BUNDLE_TARGET')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
