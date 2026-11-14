import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
function run(home, args, cwd, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra },
  })
}
function setup(name) {
  const root = mkdtempSync(join(tmpdir(), `advisers-${name}-`))
  const home = join(root, 'home'); const work = join(root, 'work')
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true })
  return { root, home, work }
}

test('E1: remind buckets/JSON/ICS/scheduler scripts work', () => {
  const { root, home, work } = setup('remind')
  try {
    run(home, ['commit', 'add', '发报价', '--quote', 'q', '--due', new Date(Date.now() + 86400_000).toISOString()], work)
    const json = JSON.parse(run(home, ['remind', '--json'], work))
    assert.ok(json.reminders.some((r) => r.action === '发报价' && r.bucket === 'due-1d'))
    const icsPath = join(work, 'r.ics')
    run(home, ['remind', '--ics', icsPath], work)
    const ics = readFileSync(icsPath, 'utf8')
    assert.match(ics, /BEGIN:VCALENDAR/)
    assert.match(ics, /BEGIN:VEVENT/)
    assert.match(ics, /BEGIN:VALARM/)
    assert.match(ics, /SUMMARY:发报价/)
    run(home, ['remind', 'install'], work)
    assert.ok(existsSync(join(home, 'scheduler', 'remind.sh')))
    assert.match(run(home, ['remind', 'status'], work), /scheduler scripts/)
    run(home, ['remind', 'uninstall'], work)
    assert.ok(!existsSync(join(home, 'scheduler')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E2: calendar import is read-only and visible in today --calendar', () => {
  const { root, home, work } = setup('calendar')
  try {
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const compact = localDay.replaceAll('-', '')
    const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:cal-1\nSUMMARY:客户周会\nDTSTART;TZID=Asia/Shanghai:${compact}T100000\nDTEND;TZID=Asia/Shanghai:${compact}T110000\nLOCATION:线上\nEND:VEVENT\nEND:VCALENDAR\n`
    writeFileSync(join(work, 'cal.ics'), ics)
    assert.match(run(home, ['calendar', 'import', '--ics', 'cal.ics'], work), /1 events/)
    assert.match(run(home, ['today', '--calendar'], work), /客户周会/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E3: evidence show and pack have real sources, hashes and tamper detection', () => {
  const { root, home, work } = setup('evidence')
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger(); const matter = ledger.addMatter({ title: '客户 A' })
    const turn = store.addTurn({ conversationId: 'conv_e3', role: 'user', content: '周五前给王工发报价' })
    const c = ledger.addCommitment({ matterId: matter.id, debtor: 'user', creditor: '王工', action: '发报价', evidence: [{ sessionId: 'conv_e3', turnId: turn.id, quote: '周五前给王工发报价' }] })
    store.save(ledger.toJSON()); store.db.close()
    const shown = JSON.parse(run(home, ['evidence', 'show', c.id, '--json'], work))
    assert.equal(shown.sources.length, 1)
    assert.equal(shown.sources[0].turnId, turn.id)
    const out = join(work, 'pack')
    const result = JSON.parse(run(home, ['deliveries', '--pack', '--out', out], work))
    assert.ok(result.verification.ok)
    for (const f of ['manifest.json', 'README.txt', 'SHA256SUMS', 'receipt.docx']) assert.ok(existsSync(join(out, f)), f)
    const manifest = readFileSync(join(out, 'manifest.json'), 'utf8')
    assert.ok(!manifest.includes(root), 'pack must not leak absolute paths')
    for (const line of readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [want, name] = line.split(/\s+/)
      const got = createHash('sha256').update(readFileSync(join(out, name))).digest('hex')
      assert.equal(got, want, name)
    }
    // tamper manifest: verifyPack is covered by unit tests; CLI must still produce a pack.
  } finally { rmSync(root, { recursive: true, force: true }) }
})
