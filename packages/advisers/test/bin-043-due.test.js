/**
 * 0.4.3 (043-1, plan 92 §1): Chinese relative dates at the CLI `--due` boundary.
 *
 * 0.4.2 silently stored a non-ISO value: `commit add --due 下周三` wrote the raw
 * string (so today/remind never saw it) and `receivable add` failed later with a
 * library error. 0.4.3 resolves or refuses at the boundary, before any write.
 *
 * The expected anchor is computed from the live Asia/Shanghai calendar day so the
 * CLI assertions do not smuggle a hard-coded run date; the fixed-anchor parser
 * matrix lives in the lib test (test/relative-date-due.test.js).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1' }

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-due-'))
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input: '', timeout: 60000,
  })
}

function json(result) {
  return JSON.parse(result.stdout)
}

/** Asia/Shanghai calendar day `offset` days from today, as YYYY-MM-DD. */
function shanghaiDay(offset = 0) {
  const now = new Date(Date.now() + offset * 86400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
}

test('commit add --due 明天 resolves to the next Shanghai day at 18:00', () => {
  const home = makeHome()
  try {
    const expectedDay = shanghaiDay(1)
    const added = run(home, ['commit', 'add', '交周报', '--quote', '周五前给我', '--due', '明天'])
    assert.equal(added.status, 0, added.stderr)
    assert.match(added.stderr, /due 解析：明天 → /)
    const rows = json(run(home, ['commit', 'ls', '--json']))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].dueAt, expectedDay + 'T18:00:00+08:00')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('commit add --due ISO is byte-identical to 0.4.2', () => {
  const home = makeHome()
  try {
    const iso = '2026-11-28T18:00:00+08:00'
    const added = run(home, ['commit', 'add', 'ISO 测试', '--quote', 'x', '--due', iso])
    assert.equal(added.status, 0, added.stderr)
    assert.doesNotMatch(added.stderr, /due 解析/)
    assert.match(added.stdout, new RegExp('due ' + iso.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const rows = json(run(home, ['commit', 'ls', '--json']))
    assert.equal(rows[0].dueAt, iso)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('commit add bad --due is E_DUE_UNRESOLVED and writes nothing', () => {
  const home = makeHome()
  try {
    const failed = run(home, ['commit', 'add', '坏日期', '--quote', 'x', '--due', '尽快'])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /E_DUE_UNRESOLVED/)
    assert.match(failed.stderr, /hint: 支持：/)
    assert.equal(run(home, ['commit', 'ls', '--json']).stdout.trim(), '[]')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('commit add conflicting --due is E_DUE_CONFLICT', () => {
  const home = makeHome()
  try {
    const failed = run(home, ['commit', 'add', '两个日期', '--quote', 'x', '--due', '下周三或月底'])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /E_DUE_CONFLICT/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('commit edit --due 明天 updates to the resolved instant', () => {
  const home = makeHome()
  try {
    run(home, ['commit', 'add', '改期', '--quote', 'x', '--due', '2026-11-28T18:00:00+08:00'])
    const id = json(run(home, ['commit', 'ls', '--json']))[0].id
    const edited = run(home, ['commit', 'edit', id, '--due', '明天'])
    assert.equal(edited.status, 0, edited.stderr)
    assert.match(edited.stderr, /due 解析：明天 → /)
    const rows = json(run(home, ['commit', 'ls', '--json']))
    assert.equal(rows[0].dueAt, shanghaiDay(1) + 'T18:00:00+08:00')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

function addClient(home) {
  const result = run(home, ['client', 'add', '客户A', '--json'])
  assert.equal(result.status, 0, result.stderr)
  return json(result).client.id
}

test('receivable add --due 明天 keeps the date-only end-of-day semantics', () => {
  const home = makeHome()
  try {
    const clientId = addClient(home)
    const expectedDay = shanghaiDay(1)
    const added = run(home, ['receivable', 'add', clientId, '尾款', '--amount', '1000', '--due', '明天', '--json'])
    assert.equal(added.status, 0, added.stderr)
    assert.equal(json(added).receivable.dueAt, expectedDay)
    assert.match(added.stderr, /due 解析：明天 → /)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('receivable add with an unresolvable --due is E_DUE_UNRESOLVED and writes nothing', () => {
  const home = makeHome()
  try {
    const clientId = addClient(home)
    const failed = run(home, ['receivable', 'add', clientId, '坏', '--amount', '1', '--due', '尽快'])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /E_DUE_UNRESOLVED/)
    const list = json(run(home, ['receivable', 'ls', '--json']))
    assert.equal(list.receivables.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})