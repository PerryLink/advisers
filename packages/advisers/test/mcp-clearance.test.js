import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { createMcpServer } from '../lib/mcp-server.js'
import { SqliteStore } from '../lib/sqlite.js'

// 0.2.5 A-2 regression: the MCP read models (today/commit_ls/who/remind/
// evidence + the four resources) used to return every ledger row regardless of
// matter secrecy. Clearance defaults to 0 and must exclude secrets and report a
// count, without echoing creditor/action/quote anywhere.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

const SECRET_QUOTE = '绝密原话不得外泄'
const SECRET_ACTION = '绝密并购谈判'
const SECRET_CREDITOR = '王总'
const SECRET_FACT_OBJECT = '绝密事实客体'
const SECRET_PREFERENCE = '绝密偏好声明'
const PUBLIC_QUOTE = '公开原话可以出现'

const FORBIDDEN = [SECRET_QUOTE, SECRET_ACTION, SECRET_CREDITOR, SECRET_FACT_OBJECT, SECRET_PREFERENCE]

function fakeLedger() {
  const publicMatter = { id: 'matter_public', title: '公开事项', status: 'active', secrecy: 0 }
  const secretMatter = { id: 'matter_secret', title: '秘密事项', status: 'active', secrecy: 2 }
  const commitments = [
    {
      id: 'cm_public',
      matterId: publicMatter.id,
      debtor: 'user',
      creditor: '李工',
      action: '公开任务',
      status: 'open',
      dueAt: '2026-12-01T10:00:00+08:00',
      evidence: [{ sessionId: 'conv_public', turnId: 'turn_public', quote: PUBLIC_QUOTE }],
    },
    {
      id: 'cm_secret',
      matterId: secretMatter.id,
      debtor: 'user',
      creditor: SECRET_CREDITOR,
      action: SECRET_ACTION,
      status: 'open',
      dueAt: '2026-12-01T10:00:00+08:00',
      evidence: [{ sessionId: 'conv_secret', turnId: 'turn_secret', quote: SECRET_QUOTE }],
    },
    {
      id: 'cm_secret_done',
      matterId: secretMatter.id,
      debtor: 'user',
      creditor: SECRET_CREDITOR,
      action: SECRET_ACTION,
      status: 'done',
      evidence: [{ sessionId: 'conv_secret', turnId: 'turn_secret', quote: SECRET_QUOTE }],
    },
  ]
  const facts = [
    { id: 'fact_public', matterId: publicMatter.id, subject: '公开主体', predicate: 'p', object: '公开客体', status: 'confirmed', evidence: [] },
    { id: 'fact_secret', matterId: secretMatter.id, subject: '秘密主体', predicate: 'p', object: SECRET_FACT_OBJECT, status: 'confirmed', evidence: [] },
  ]
  const preferences = [
    { id: 'pref_global', kind: 'preference', statement: '公开偏好', scope: { level: 'global' }, status: 'confirmed', evidence: [] },
    { id: 'pref_secret', kind: 'preference', statement: SECRET_PREFERENCE, scope: { level: 'matter', value: secretMatter.id }, status: 'confirmed', evidence: [] },
  ]
  const visibleByMatter = (rows, matterId) => (matterId ? rows.filter((row) => row.matterId === matterId) : rows)
  return {
    matters: [publicMatter, secretMatter],
    getMatter(id) {
      return this.matters.find((matter) => matter.id === id)
    },
    listMatters() {
      return this.matters
    },
    listCommitments(matterId) {
      return visibleByMatter(commitments, matterId)
    },
    openCommitments(matterId) {
      return visibleByMatter(commitments, matterId).filter((row) => row.status === 'open')
    },
    listFacts() {
      return facts
    },
    listPreferences() {
      return preferences
    },
  }
}

function fakeStore() {
  const turns = {
    turn_public: { id: 'turn_public', conversationId: 'conv_public', seq: 1, role: 'user', content: PUBLIC_QUOTE },
    turn_secret: { id: 'turn_secret', conversationId: 'conv_secret', seq: 1, role: 'user', content: SECRET_QUOTE },
  }
  return { getTurn: (id) => turns[id] }
}

function makeServer(ledger) {
  return createMcpServer({
    ledger,
    store: fakeStore(),
    audit: () => {},
    now: () => new Date('2026-11-28T03:00:00.000Z'),
  })
}

async function callTool(server, name, args = {}, id = 1) {
  const response = await server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const text = response.result?.content?.[0]?.text
  let data
  try {
    data = text === undefined ? undefined : JSON.parse(text)
  } catch {
    data = undefined
  }
  return { response, isError: response.result?.isError === true, text, data }
}

function assertNoSecrets(text) {
  for (const needle of FORBIDDEN) assert.equal(String(text).includes(needle), false, 'MCP output must not contain "' + needle + '"')
}

test('mcp clearance: every read model excludes secrecy>clearance records and reports a count', async () => {
  const server = makeServer(fakeLedger())

  const today = await callTool(server, 'advisers_today')
  assert.equal(today.isError, false)
  assert.equal(today.data.open, 1)
  assert.deepEqual(today.data.commitments.map((row) => row.id), ['cm_public'])
  assert.equal(today.data.clearance, 0)
  assert.equal(today.data.protectedExcluded, 1)
  assertNoSecrets(today.text)

  const commitLs = await callTool(server, 'advisers_commit_ls', { all: true })
  assert.deepEqual(commitLs.data.commitments.map((row) => row.id), ['cm_public'])
  assert.equal(commitLs.data.protectedExcluded, 2)
  assertNoSecrets(commitLs.text)

  const who = await callTool(server, 'advisers_who')
  assert.deepEqual(who.data.mine.map((row) => row.id), ['cm_public'])
  assert.deepEqual(who.data.waiting, [])
  assert.equal(who.data.protectedExcluded, 1)
  assertNoSecrets(who.text)

  const reminders = await callTool(server, 'advisers_remind')
  assert.ok(Array.isArray(reminders.data.reminders))
  assert.deepEqual(reminders.data.reminders.map((row) => row.commitmentId), ['cm_public'])
  assert.equal(reminders.data.protectedExcluded, 1)
  assertNoSecrets(reminders.text)

  const publicEvidence = await callTool(server, 'advisers_evidence', { id: 'cm_public' })
  assert.equal(publicEvidence.isError, false)
  assert.equal(publicEvidence.data.sources.length, 1)
  assert.equal(publicEvidence.data.sources[0].quote, PUBLIC_QUOTE)
  assert.equal(publicEvidence.data.protectedExcluded, 0)

  for (const id of ['cm_secret', 'fact_secret', 'pref_secret']) {
    const withheld = await callTool(server, 'advisers_evidence', { id })
    assert.equal(withheld.isError, false)
    assert.equal(withheld.data.protectedExcluded, 1)
    assert.equal(withheld.data.clearance, 0)
    assert.deepEqual(withheld.data.sources, [])
    assert.deepEqual(withheld.data.missing, [])
    assert.equal(withheld.data.cm_secret, undefined)
    assert.equal(withheld.data.fact_secret, undefined)
    assert.equal(withheld.data.pref_secret, undefined)
    assertNoSecrets(withheld.text)
  }

  // Resource reads go through the same filtered models.
  const readResource = async (uri, id) => {
    const response = await server.handle({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri } })
    return JSON.parse(response.result.contents[0].text)
  }
  const todayResource = await readResource('advisers://today', 10)
  assert.equal(todayResource.open, 1)
  assert.equal(todayResource.protectedExcluded, 1)
  assertNoSecrets(JSON.stringify(todayResource))

  const commitmentsResource = await readResource('advisers://commitments', 11)
  assert.deepEqual(commitmentsResource.commitments.map((row) => row.id), ['cm_public'])
  assert.equal(commitmentsResource.protectedExcluded, 2)
  assertNoSecrets(JSON.stringify(commitmentsResource))

  const whoResource = await readResource('advisers://who', 12)
  assert.deepEqual(whoResource.mine.map((row) => row.id), ['cm_public'])
  assert.equal(whoResource.protectedExcluded, 1)
  assertNoSecrets(JSON.stringify(whoResource))

  const evidenceResource = await readResource('advisers://evidence', 13)
  assert.deepEqual(evidenceResource.commitments.map((row) => row.id), ['cm_public'])
  assert.deepEqual(evidenceResource.facts.map((row) => row.id), ['fact_public'])
  assert.deepEqual(evidenceResource.preferences.map((row) => row.id), ['pref_global'])
  assert.equal(evidenceResource.protectedExcluded, 4)
  assertNoSecrets(JSON.stringify(evidenceResource))
})

test('mcp --stdio: a real sqlite ledger with a secrecy=2 matter never reaches the wire (A-2 regression)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-clearance-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const publicMatter = ledger.addMatter({ title: '公开事项', secrecy: 0 })
    const secretMatter = ledger.addMatter({ title: '秘密事项', secrecy: 2 })
    const publicTurn = store.addTurn({ conversationId: 'conv_public', role: 'user', content: PUBLIC_QUOTE })
    const secretTurn = store.addTurn({ conversationId: 'conv_secret', role: 'user', content: SECRET_QUOTE })
    const publicCommitment = ledger.addCommitment({
      matterId: publicMatter.id,
      debtor: 'user',
      creditor: '李工',
      action: '公开任务',
      dueAt: '2026-12-01T10:00:00+08:00',
      evidence: [{ sessionId: 'conv_public', turnId: publicTurn.id, quote: PUBLIC_QUOTE }],
    })
    const secretCommitment = ledger.addCommitment({
      matterId: secretMatter.id,
      debtor: 'user',
      creditor: SECRET_CREDITOR,
      action: SECRET_ACTION,
      dueAt: '2026-12-01T10:00:00+08:00',
      evidence: [{ sessionId: 'conv_secret', turnId: secretTurn.id, quote: SECRET_QUOTE }],
    })
    const secretFact = ledger.remember({
      subject: '秘密主体',
      predicate: '秘密谓词',
      object: SECRET_FACT_OBJECT,
      matterId: secretMatter.id,
      evidence: [{ quote: SECRET_QUOTE, ref: 'conv_secret#' + secretTurn.id }],
    })
    store.save(ledger.toJSON())
    store.close()

    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'advisers_commit_ls', arguments: { all: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisers_who', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'advisers_evidence', arguments: { id: secretCommitment.id } } },
      { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'advisers://today' } },
      { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'advisers://commitments' } },
      { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'advisers://who' } },
      { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'advisers://evidence' } },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'advisers_evidence', arguments: { id: publicCommitment.id } } },
    ]
    const input = requests.map((request) => JSON.stringify(request)).join('\n') + '\n'
    const out = spawnSync(process.execPath, [bin, 'mcp', '--stdio'], {
      cwd: work,
      input,
      encoding: 'utf8',
      timeout: 60000,
      env: tosEnv(home, {
        ...process.env,
        ADVISERS_HOME: home,
        ADVISERS_CORE_LOCAL: '1',
        ADVISERS_OFFICE_LOCAL: '1',
        ADVISERS_STORE: 'sqlite',
        ADVISERS_NO_MODEL: '1',
      }),
    })
    assert.equal(out.status, 0, out.stderr)
    const lines = out.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const byId = new Map(lines.map((line) => [line.id, line]))
    const dataOf = (id) => {
      const block = byId.get(id).result.content[0].text
      return JSON.parse(block)
    }

    assert.equal(dataOf(1).open, 1)
    assert.equal(dataOf(1).protectedExcluded, 1)
    assert.deepEqual(dataOf(2).commitments.map((row) => row.id), [publicCommitment.id])
    assert.equal(dataOf(2).protectedExcluded, 1)
    assert.deepEqual(dataOf(3).mine.map((row) => row.id), [publicCommitment.id])
    assert.equal(dataOf(3).protectedExcluded, 1)

    const withheld = dataOf(4)
    assert.equal(withheld.protectedExcluded, 1)
    assert.deepEqual(withheld.sources, [])
    assert.deepEqual(withheld.missing, [])

    const todayResource = JSON.parse(byId.get(5).result.contents[0].text)
    assert.equal(todayResource.open, 1)
    assert.equal(todayResource.protectedExcluded, 1)
    const commitmentsResource = JSON.parse(byId.get(6).result.contents[0].text)
    assert.deepEqual(commitmentsResource.commitments.map((row) => row.id), [publicCommitment.id])
    assert.equal(commitmentsResource.protectedExcluded, 1)
    const whoResource = JSON.parse(byId.get(7).result.contents[0].text)
    assert.deepEqual(whoResource.mine.map((row) => row.id), [publicCommitment.id])
    const evidenceResource = JSON.parse(byId.get(8).result.contents[0].text)
    assert.deepEqual(evidenceResource.commitments.map((row) => row.id), [publicCommitment.id])
    assert.deepEqual(evidenceResource.facts, [])
    assert.equal(evidenceResource.protectedExcluded, 2)
    const publicEvidence = dataOf(9)
    assert.equal(publicEvidence.sources.length, 1)
    assert.equal(publicEvidence.sources[0].quote, PUBLIC_QUOTE)

    // Nothing protected ever reached stdout (ids may appear in our request echo
    // only if the server leaked; assert on the full wire output).
    for (const needle of [...FORBIDDEN, secretCommitment.id, secretFact.id]) {
      assert.equal(out.stdout.includes(needle), false, 'MCP stdout must not contain "' + needle + '"')
      assert.equal(out.stderr.includes(needle), false, 'MCP stderr must not contain "' + needle + '"')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
