// 0.3.2: subject-scoped receipt packs (`deliveries --receipt --client/--project`).
//
// The security boundary of a subject pack is this CLI filtering: only the
// subject's delivered files and evidence may enter the pack, protected records
// are counted not copied, and a bounded pack must say so. The pack verifier is
// covered by test/receipt-pack-v2.test.js and test/cli-data-wiring.test.js.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
  })
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home), encoding: 'utf8' })
}

function runJson(home, args) {
  const result = run(home, args)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

/** Two clients, two matters, two delivered text artifacts (A and B). */
function seedTwoClients(home, work) {
  mkdirSync(work, { recursive: true })
  const aFile = join(work, 'a-note.txt')
  const bFile = join(work, 'b-note.txt')
  writeFileSync(aFile, 'delivered for client A')
  writeFileSync(bFile, 'delivered for client B')
  const store = new SqliteStore(join(home, 'state.db'))
  const ledger = new Ledger()
  const matterA = ledger.addMatter({ title: 'A 的官网改版' })
  const matterB = ledger.addMatter({ title: 'B 的年度顾问' })
  store.save(ledger.toJSON())
  const turn = store.addTurn({ conversationId: 'conv_subject', role: 'user', content: 'A 的报价确认单' })
  const clientA = store.addClient({ name: '客户甲', aliases: ['甲总'] })
  const clientB = store.addClient({ name: '客户乙' })
  store.setMatterClient(matterA.id, { clientId: clientA.id })
  store.setMatterClient(matterB.id, { clientId: clientB.id })
  store.addDelivery({ matterId: matterA.id, conversationId: 'conv_subject', files: [aFile], tool: 'deliver:confirmation', title: 'A 的报价确认单', validation: 'txt' })
  store.addDelivery({ matterId: matterB.id, conversationId: 'conv_subject', files: [bFile], tool: 'deliver:confirmation', title: 'B 的季度报告', validation: 'txt' })
  store.db.close()
  return { clientA, clientB, matterA, matterB, aFile, bFile }
}

test('receipt --client: only that client\'s deliveries/evidence enter the pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-subject-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  try {
    const { clientA, clientB, matterA } = seedTwoClients(home, work)
    const out = join(work, 'pack-a')
    const payload = runJson(home, ['deliveries', '--receipt', '--client', clientA.id, '--out', out])
    assert.equal(payload.ok, true)
    assert.equal(payload.version, 2)
    assert.equal(payload.scope, 'subject')
    assert.deepEqual(payload.subject, { kind: 'client', id: clientA.id, name: clientA.name })
    assert.equal(payload.deliveryCount, 1)
    assert.equal(payload.deliveriesTotal, 1)
    assert.equal(payload.deliveriesTruncated, false)
    assert.equal(payload.verification.ok, true)

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 2)
    assert.equal(manifest.scope, 'subject')
    assert.deepEqual(manifest.subject, { kind: 'client', id: clientA.id, name: clientA.name })
    assert.equal(manifest.deliveries.length, 1)
    assert.equal(manifest.deliveries[0].matterId, matterA.id)
    assert.equal(manifest.deliveries[0].clientId, clientA.id)

    const readme = readFileSync(join(out, 'README.txt'), 'utf8')
    assert.match(readme, /Scope|scope/)
    assert.match(readme, /只含|only/)
    // The other client's id/name/title/file bytes must not leak into the pack.
    for (const banned of [clientB.id, clientB.name, '季度报告', 'delivered for client B']) {
      assert.ok(!readme.includes(banned), 'README leaks ' + banned)
      assert.ok(!readFileSync(join(out, 'manifest.json'), 'utf8').includes(banned), 'manifest leaks ' + banned)
    }
    // Offline verify accepts the v2 pack.
    const verified = runJson(home, ['evidence', 'verify', out])
    assert.equal(verified.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('receipt without subject is labelled local-all and warns against forwarding', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-localall-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  try {
    seedTwoClients(home, work)
    const out = join(work, 'pack-all')
    const payload = runJson(home, ['deliveries', '--receipt', '--out', out])
    assert.equal(payload.scope, 'local-all')
    assert.equal(payload.subject, null)
    assert.equal(payload.deliveryCount, 2)
    const readme = readFileSync(join(out, 'README.txt'), 'utf8')
    assert.match(readme, /全部客户数据|ALL local customer data|all local customer data/i)
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.scope, 'local-all')
    assert.equal(manifest.subject, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('receipt subject fails closed on unknown ids, secrecy and bounded scans', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-subject-errors-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  try {
    const { clientA, clientB } = seedTwoClients(home, work)

    const unknown = run(home, ['deliveries', '--receipt', '--client', 'cl_missing', '--out', join(work, 'x1')])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /E_CLIENT_NOT_FOUND/)

    const unknownProject = run(home, ['deliveries', '--receipt', '--project', 'prj_missing', '--out', join(work, 'x2')])
    assert.equal(unknownProject.status, 1)
    assert.match(unknownProject.stderr, /E_PROJECT_NOT_FOUND/)

    // A client-level secrecy default above the pack clearance is a hard block:
    // the pack must not silently become empty (or leak) for a secret client.
    const store = new SqliteStore(join(home, 'state.db'))
    store.updateClient(clientB.id, { secrecyDefault: 2 })
    store.db.close()
    const blocked = run(home, ['deliveries', '--receipt', '--client', clientB.id, '--out', join(work, 'x3')])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /E_SECRECY_BLOCKED/)
    assert.equal(existsSync(join(work, 'x3')), false, 'a blocked receipt must not write a pack')

    // A subject pack is bounded by --limit (default 100) and says when it was.
    const limited = runJson(home, ['deliveries', '--receipt', '--client', clientA.id, '--out', join(work, 'x4'), '--limit', '1'])
    assert.equal(limited.deliveryCount, 1)
    assert.equal(limited.deliveriesTotal, 1)
    assert.equal(limited.deliveriesTruncated, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
