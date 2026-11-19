/**
 * 0.3.0 Wave 3 JSON-contract fixes (plan 26 §5.4/§10.3):
 *   - `advisers week --json` used to print Chinese human text because the
 *     dispatch keyed off the *store* mode instead of the --json flag;
 *   - an unknown `commit` subcommand (e.g. `commit show nope --json`) printed a
 *     human usage line and no JSON envelope.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isJsonPure } from '../lib/tui/json.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const SH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
/** Asia/Shanghai calendar day (YYYY-MM-DD) at `offsetDays` from now. */
function localDay(offsetDays = 0) { return SH.format(new Date(Date.now() + offsetDays * 86400_000)) }

function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-json-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}
function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function cli(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8', input: '', timeout: 20000 })
}

test('0.3.0: week --json is a pure JSON window document, not human text', () => {
  const ws = workspace('week')
  try {
    const today = localDay(0)
    const from = localDay(-6)
    const old = localDay(-30)
    const future = localDay(10)
    const seeds = [['本周到期', today], ['旧逾期', old], ['下周到期', future]]
    for (const [action, day] of seeds) {
      const seed = cli(ws.home, ['commit', 'add', action, '--quote', 'q', '--due', day + 'T09:00:00+08:00'])
      assert.equal(seed.status, 0, action + ': ' + seed.stderr)
    }
    const result = cli(ws.home, ['week', '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(isJsonPure(result.stdout), 'week --json stdout is not one pure JSON document')
    const data = JSON.parse(result.stdout)
    assert.equal(data.ok, true)
    assert.equal(data.command, 'week')
    assert.deepEqual(data.window, { from, to: today, days: 7, timezone: 'Asia/Shanghai' })
    assert.equal(data.due, 1, 'only the in-window commitment counts as this week due')
    assert.equal(data.items.length, 1)
    assert.equal(data.items[0].action, '本周到期')
    assert.ok(String(data.items[0].due).startsWith(today))
    assert.ok(data.overdue >= 1, 'the 30-day-old open item must be overdue, not a window due')
    assert.equal(data.items.some((item) => item.action === '旧逾期'), false)
    // The human view keeps the same corrected local-day window.
    const human = cli(ws.home, ['week'])
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, new RegExp('本周（' + from + ' – ' + today + '）'))
    assert.match(human.stdout, /逾期 [0-9]+ 件/)
    assert.match(human.stdout, /本周到期/)
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})

test('0.3.0: a failed --json command stays machine-readable (commit unknown subcommand)', () => {
  const ws = workspace('commit')
  try {
    const show = cli(ws.home, ['commit', 'show', 'nope', '--json'])
    assert.equal(show.status, 1)
    assert.equal(show.stdout, '', 'stdout must stay empty on a --json failure')
    const envelope = JSON.parse(show.stderr)
    assert.equal(envelope.error.code, 'E_USAGE')
    assert.match(envelope.error.message, /show/)
    assert.match(envelope.error.hint, /commit/)
    // Without --json the historical human usage line is unchanged.
    const human = cli(ws.home, ['commit', 'show', 'nope'])
    assert.equal(human.status, 1)
    assert.equal(human.stdout, '')
    assert.match(human.stderr, /usage: advisers commit/)
    assert.equal(human.stderr.trim().startsWith('{'), false)
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})
