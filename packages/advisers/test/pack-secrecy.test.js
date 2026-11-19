import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

// 0.2.5 A-1 regression: deliveries --pack / --receipt used to check only the
// ACTIVE matter's secrecy while the pack materialized every matter's evidence.
// A secrecy=3 matter therefore leaked its quote into another matter's pack.
// The fix is per-item: every included record is judged by its own matter.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

const PUBLIC_QUOTE = '普通原话可以出现'
const SECRET_QUOTE = '绝密原话不得外泄'
const SECRET_ACTION = '绝密并购谈判'
const SECRET_CREDITOR = '王总'
const SECRET_FACT_OBJECT = '绝密事实客体'
const SECRET_PREFERENCE = '绝密偏好声明'
const SECRET_ARTIFACT = '绝密交付副本内容'

function env(home) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_NO_MODEL: '1',
  })
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home), encoding: 'utf8' })
}

function filesUnder(dir) {
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(dir)
  return files
}

function allText(dir) {
  return filesUnder(dir)
    .map((file) => readFileSync(file).toString('utf8'))
    .join('\n')
}

function assertNoProtectedContent(dir, { ids = [] } = {}) {
  const forbidden = [SECRET_QUOTE, SECRET_ACTION, SECRET_CREDITOR, SECRET_FACT_OBJECT, SECRET_PREFERENCE, SECRET_ARTIFACT, ...ids]
  for (const file of filesUnder(dir)) {
    const text = readFileSync(file).toString('utf8')
    for (const needle of forbidden) {
      assert.equal(text.includes(needle), false, relative(dir, file) + ' must not contain "' + needle + '"')
    }
  }
}

function seed(root) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  const ledger = new Ledger()
  const publicMatter = ledger.addMatter({ title: '公开事项', secrecy: 0 })
  const secretMatter = ledger.addMatter({ title: '秘密事项', secrecy: 3 })
  const publicTurn = store.addTurn({ conversationId: 'conv_public', role: 'user', content: PUBLIC_QUOTE })
  const secretTurn = store.addTurn({ conversationId: 'conv_secret', role: 'user', content: SECRET_QUOTE })
  const publicCommitment = ledger.addCommitment({
    matterId: publicMatter.id,
    debtor: 'user',
    creditor: '王工',
    action: '普通承诺',
    evidence: [{ sessionId: 'conv_public', turnId: publicTurn.id, quote: PUBLIC_QUOTE }],
  })
  const secretCommitment = ledger.addCommitment({
    matterId: secretMatter.id,
    debtor: 'user',
    creditor: SECRET_CREDITOR,
    action: SECRET_ACTION,
    evidence: [{ sessionId: 'conv_secret', turnId: secretTurn.id, quote: SECRET_QUOTE }],
  })
  const secretFact = ledger.remember({
    subject: '秘密主体',
    predicate: '秘密谓词',
    object: SECRET_FACT_OBJECT,
    matterId: secretMatter.id,
    evidence: [{ quote: SECRET_QUOTE, ref: 'conv_secret#' + secretTurn.id }],
  })
  const secretPreference = ledger.addPreference({
    kind: 'preference',
    statement: SECRET_PREFERENCE,
    scope: { level: 'matter', value: secretMatter.id },
    evidence: [{ quote: SECRET_QUOTE, ref: 'conv_secret#' + secretTurn.id }],
  })
  store.save(ledger.toJSON())
  const publicArtifact = join(root, 'public.txt')
  const secretArtifact = join(root, 'secret.txt')
  writeFileSync(publicArtifact, '公开交付文件内容\n')
  writeFileSync(secretArtifact, SECRET_ARTIFACT + '\n')
  store.addDelivery({
    matterId: publicMatter.id,
    conversationId: 'conv_public',
    files: [publicArtifact],
    tool: 'deliver:confirmation',
    title: '公开确认单',
  })
  store.addDelivery({
    matterId: secretMatter.id,
    conversationId: 'conv_secret',
    files: [secretArtifact],
    tool: 'deliver:confirmation',
    title: '绝密确认单',
  })
  store.close()
  return { home, publicMatter, secretMatter, publicCommitment, secretCommitment, secretFact, secretPreference, secretArtifact }
}

test('deliveries --pack excludes protected matters per item (A-1 regression)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-pack-secrecy-'))
  try {
    const seeded = seed(root)
    const out = join(root, 'pack')
    const result = run(seeded.home, ['deliveries', '--pack', '--out', out])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.clearance, 0)
    // The bulk path requests commitments/facts plus non-matter-scoped
    // preferences; the secrecy=3 commitment and fact are withheld.
    assert.equal(payload.protectedExcluded, 2)
    assert.equal(payload.verification.ok, true)

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.entryCount, 1)
    assert.deepEqual(manifest.entries.map((entry) => entry.id), [seeded.publicCommitment.id])
    assert.equal(allText(out).includes(PUBLIC_QUOTE), true)
    assertNoProtectedContent(out, { ids: [seeded.secretCommitment.id, seeded.secretFact.id, seeded.secretPreference.id] })

    // Explicit --ids pointing at a protected item fails closed: no pack dir, no
    // title/creditor/action/quote in the error.
    const explicitDir = join(root, 'pack-explicit')
    const explicit = run(seeded.home, ['deliveries', '--pack', '--out', explicitDir, '--ids', seeded.secretCommitment.id])
    assert.equal(explicit.status, 1)
    assert.match(explicit.stderr, /refusing to export 1 evidence item/)
    assert.match(explicit.stderr, /secrecy/)
    for (const needle of [SECRET_QUOTE, SECRET_ACTION, SECRET_CREDITOR, SECRET_FACT_OBJECT, SECRET_PREFERENCE]) {
      assert.equal(explicit.stderr.includes(needle), false, 'the fail-closed error must not leak content')
      assert.equal(explicit.stdout.includes(needle), false)
    }
    assert.equal(existsSync(explicitDir), false, 'a refused pack must not leave a directory')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliveries --receipt excludes protected evidence and protected delivered copies (A-1 regression)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-secrecy-'))
  try {
    const seeded = seed(root)
    const out = join(root, 'receipt')
    const result = run(seeded.home, ['deliveries', '--receipt', '--out', out])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.clearance, 0)
    assert.equal(payload.deliveriesProtectedExcluded, 1)
    assert.equal(payload.evidenceProtectedExcluded, 2)
    assert.equal(payload.protectedExcluded, 3)
    assert.equal(payload.deliveryCount, 1)

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.deliveries.length, 1)
    assert.equal(manifest.evidence.entryCount, 1)
    assert.equal(manifest.evidence.protectedExcluded, 2)
    assert.equal(manifest.evidence.entries[0].id, seeded.publicCommitment.id)

    // Only the public deliverable is copied; the protected artifact is not read.
    const copied = filesUnder(join(out, 'deliveries'))
    assert.equal(copied.length, 1)
    assert.ok(copied[0].endsWith('public.txt'), copied[0])
    assertNoProtectedContent(out, { ids: [seeded.secretCommitment.id, seeded.secretFact.id, seeded.secretPreference.id] })

    // A receipt whose only deliveries are protected fails closed instead of
    // silently producing an empty pack.
    const explicitDir = join(root, 'receipt-explicit')
    const explicit = run(seeded.home, ['deliveries', '--receipt', '--out', explicitDir, '--ids', seeded.secretCommitment.id])
    assert.equal(explicit.status, 1)
    assert.match(explicit.stderr, /refusing to export 1 evidence item/)
    assert.equal(existsSync(explicitDir), false)
    for (const needle of [SECRET_QUOTE, SECRET_ACTION, SECRET_CREDITOR]) {
      assert.equal(explicit.stderr.includes(needle), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
