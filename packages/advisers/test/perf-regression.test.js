import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import { buildSimplePdf, findCjkFont, wrapToWidth } from '../lib/pdf.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), `advisers-perf-${name}-`))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

function cli(home, args, cwd, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ADVISERS_HOME: home,
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_NO_MODEL: '1',
      ADVISERS_STORE: 'sqlite',
      ...extra,
    },
  })
}

/** Asia/Shanghai midnight + 12h for the current local day (stable "today"). */
function localNoon(offsetDays = 0) {
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  return Date.parse(`${localDay}T12:00:00+08:00`) + offsetDays * 86400_000
}

test('today keeps its formatted one-screen output after the Intl formatter hoist', () => {
  const { root, home, work } = setup('today')
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '性能回归' })
    const add = (action, dueAt, extra = {}) => ledger.addCommitment({
      matterId: matter.id,
      debtor: 'user',
      creditor: '王工',
      action,
      dueAt,
      capability: 'todo',
      evidence: [{ sessionId: 's', turnId: 't', quote: action }],
      ...extra,
    })
    add('逾期三天', new Date(localNoon(-3)).toISOString())
    add('今天要做', new Date(localNoon(0)).toISOString())
    add('三天后', new Date(localNoon(3)).toISOString())
    add('等第三方回复', new Date(localNoon(30)).toISOString(), { debtor: 'third:王工' })
    add('没有截止', undefined)
    store.save(ledger.toJSON())
    store.close()

    const first = cli(home, ['today'], work)
    assert.match(first, /^今天：1 · 逾期：1 · 未来 7 天：1 · 等别人：1 · 无截止：1$/m)
    assert.match(first, /下一件：逾期三天/)
    // The same data renders identically twice (no formatter state leaks).
    assert.equal(cli(home, ['today'], work), first)
    assert.equal(existsSync(join(home, 'state.json')), false, 'today still never writes JSON state')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tick keeps nudge levels/counts and writes no audit rows after batching', () => {
  const { root, home, work } = setup('tick')
  try {
    const db = join(home, 'state.db')
    const store = new SqliteStore(db)
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '性能回归' })
    const add = (action, dueAt, extra = {}) => ledger.addCommitment({
      matterId: matter.id,
      debtor: 'user',
      creditor: '王工',
      action,
      dueAt,
      capability: 'todo',
      evidence: [{ sessionId: 's', turnId: 't', quote: action }],
      ...extra,
    })
    const now = Date.now()
    const today = new Date(localNoon(0)).toISOString()
    const later = new Date(localNoon(3)).toISOString()
    const l2 = []
    for (let i = 0; i < 5; i++) l2.push(add(`今天${i}`, today))
    for (let i = 0; i < 3; i++) add(`三天后${i}`, later)
    const woken = add('snooze 已到期', today)
    Object.assign(woken, { status: 'snoozed' })
    const stillSnoozed = add('snooze 未到期', today)
    Object.assign(stillSnoozed, { status: 'snoozed' })
    const done = add('已经完成', today)
    Object.assign(done, { status: 'done', doneAt: new Date(now).toISOString() })
    const far = add('三十天后', new Date(localNoon(30)).toISOString())
    store.save(ledger.toJSON())
    store.setMeta(`snooze:${woken.id}`, new Date(now - 3600_000).toISOString())
    store.setMeta(`snooze:${stillSnoozed.id}`, new Date(now + 3600_000).toISOString())
    store.close()

    const firstTick = JSON.parse(cli(home, ['tick', '--json'], work))
    assert.equal(firstTick.localDay, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now)))
    assert.equal(firstTick.due.length, 9, 'five today + three in 3 days + the woken snooze')
    assert.equal(firstTick.due.filter((c) => c.level === 'L2').length, 3, 'L2 budget is three per day')
    assert.equal(firstTick.due.filter((c) => c.level === 'L1').length, 6)
    assert.deepEqual(firstTick.due.filter((c) => c.id === stillSnoozed.id), [])
    assert.deepEqual(firstTick.due.filter((c) => c.id === done.id || c.id === far.id), [])

    const secondTick = JSON.parse(cli(home, ['tick', '--json'], work))
    assert.equal(secondTick.due.length, 9, 'the second tick reports the same due set')
    assert.equal(secondTick.due.filter((c) => c.level === 'L2').length, 0, 'the L2 budget is already spent')
    assert.equal(secondTick.localDay, firstTick.localDay)
    assert.equal(secondTick.due.filter((c) => c.level === 'L1').length, 9)

    // The three commitments that were L2 on the first run switch to L1 on the
    // second run: that is one new dedupe key each, and no key is ever rewritten.
    const thirdTick = JSON.parse(cli(home, ['tick', '--json'], work))
    assert.equal(thirdTick.due.length, 9)

    const reopened = new SqliteStore(db)
    try {
      const nudges = reopened.listNudges(100)
      assert.equal(nudges.length, 12, 'first tick 9 rows + the three level changes; then stable')
      assert.equal(reopened.countNudges(firstTick.localDay, 'L2'), 3)
      assert.equal(reopened.countNudges(firstTick.localDay, 'L1'), 9)
      assert.equal(new Set(nudges.map((n) => n.dedupe_key)).size, 12, 'dedupe keys are unique')
      assert.equal(reopened.listNudges(100).filter((n) => n.commitment_id === stillSnoozed.id).length, 0)
      assert.equal(reopened.listNudges(100).filter((n) => n.commitment_id === done.id || n.commitment_id === far.id).length, 0)
      // snoozed rows: the expired one wakes (status + meta cleanup), the future one is untouched.
      assert.equal(reopened.getMeta(`snooze:${woken.id}`), undefined)
      assert.ok(reopened.getMeta(`snooze:${stillSnoozed.id}`))
      const reloaded = Ledger.fromJSON(reopened.load())
      assert.equal(reloaded.listCommitments().find((c) => c.id === woken.id).status, 'open')
      assert.equal(reloaded.listCommitments().find((c) => c.id === stillSnoozed.id).status, 'snoozed')
      // tick never wrote an audit row (only explicit commands do) and the chain stays valid.
      assert.equal(reopened.listAudit(100).length, 0)
      assert.equal(reopened.verifyAudit().ok, true)
    } finally {
      reopened.close()
    }
    assert.equal(existsSync(join(home, 'state.json')), false, 'tick never falls back to JSON')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliver caps the default open-commitment list at 500 and requires --all for all', () => {
  const { root, home, work } = setup('deliver')
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '性能回归' })
    for (let i = 0; i < 505; i++) {
      ledger.addCommitment({
        matterId: matter.id,
        debtor: 'user',
        creditor: '王工',
        action: `发送第${i}版交付物`,
        capability: 'todo',
        evidence: [{ sessionId: 's', turnId: 't', quote: '交付物' }],
      })
    }
    store.save(ledger.toJSON())
    store.close()

    const defaultOut = join(work, 'default.docx')
    const printed = cli(home, ['deliver', '--format', 'docx', '--out', defaultOut], work)
    assert.match(printed, /wrote /)
    assert.match(printed, /提示：共 505 条未完成承诺，本文件只生成前 500 条；用 --all 生成全部。/)
    assert.ok(statSync(defaultOut).size > 1000)

    const defaultJson = JSON.parse(cli(home, ['deliver', '--format', 'docx', '--out', join(work, 'default2.docx'), '--json'], work))
    assert.equal(defaultJson.truncated, true)
    assert.equal(defaultJson.total, 505)
    assert.equal(defaultJson.commitments, 500)

    const allOut = join(work, 'all.docx')
    const allJson = JSON.parse(cli(home, ['deliver', '--format', 'docx', '--out', allOut, '--all', '--json'], work))
    assert.equal(allJson.truncated, false)
    assert.equal(allJson.total, 505)
    assert.equal(allJson.commitments, 505)
    // --all documents the extra five commitments; the compressed .docx size can
    // move either way, so check the text that is actually inside each file.
    assert.equal(readFileSync(allOut).subarray(0, 2).toString(), 'PK')
    const countActions = (text) => (text.match(/发送第/g) ?? []).length
    assert.equal(countActions(cli(home, ['office-read', defaultOut], work)), 500)
    assert.equal(countActions(cli(home, ['office-read', allOut], work)), 505)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wrapToWidth matches the historical prefix-measuring algorithm for additive fonts', () => {
  // Reference font whose advance widths are additive by construction, i.e. the
  // font class pdf.js supports. widthOfTextAtSize() must therefore equal the sum
  // of the per-character advances, which is what wrapToWidth caches and sums.
  const additiveFont = {
    widthOfTextAtSize(text, size) {
      let wide = 0
      for (const ch of String(text)) wide += ch.codePointAt(0) > 0x2e7f ? 2 : 1
      return wide * (size / 10.5) * 10.5
    },
  }
  const historicalWrap = (text, size, maxWidth) => {
    const lines = []
    let current = ''
    for (const ch of String(text)) {
      if (ch === '\n') { lines.push(current); current = ''; continue }
      const next = current + ch
      if (additiveFont.widthOfTextAtSize(next, size) > maxWidth && current) {
        lines.push(current)
        current = ch
      } else current = next
    }
    if (current) lines.push(current)
    return lines
  }
  const corpus = [
    '发报价 · 截止 2026-11-20 · open',
    'cm_1  王工 · 发送第1版交付物 · 截止 2026-11-21 · 附上人力单价与总价明细 · open',
    'The quick brown fox jumps over the lazy dog.',
    '混合 mixed 中英 text with punctuation，。！？',
    '',
    '\n',
    'a\n\nb',
    'x'.repeat(400),
    '超'.repeat(400),
  ]
  for (let i = 0; i < 200; i++) {
    corpus.push(`cm_${i}  王工 · 发送第${i}版交付物 · 截止 2026-11-${10 + (i % 19)} · open · 明细与发票`)
  }
  for (const text of corpus) {
    assert.deepEqual(wrapToWidth(text, additiveFont, 10.5, 120), historicalWrap(text, 10.5, 120), text)
  }
})

test('wrapToWidth reproduces the prefix-measuring line breaks for the host CJK font', async (t) => {
  const fontPath = findCjkFont()
  if (!fontPath) { t.skip('no CJK font on this host'); return }
  const { PDFDocument } = await import('pdf-lib')
  const fontkit = (await import('@pdf-lib/fontkit')).default
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(readFileSync(fontPath), { subset: true })
  const width = (text) => font.widthOfTextAtSize(text, 10.5)
  const corpus = [
    '发报价 · 截止 2026-11-20 · open',
    'AVATAR WAVE To Yo We Ta LT VA AWAY office document',
    'The quick brown fox jumps over the lazy dog.',
    '混合 mixed 中英 text with kerning AV and 标点，。！',
  ]
  for (let i = 0; i < 100; i++) corpus.push(`cm_${i}  王工 · 发送第${i}版交付物 · 截止 2026-11-${10 + (i % 19)} · open`)
  // Only assert equality when the host font's advances are additive (the class
  // of CJK fonts Advisers ships with); a kerning font can legitimately differ.
  for (const text of corpus) {
    const chars = [...text]
    for (let i = 0; i < chars.length - 1; i++) {
      if (Math.abs(width(chars[i] + chars[i + 1]) - width(chars[i]) - width(chars[i + 1])) > 1e-6) {
        t.skip('host CJK font applies pair kerning; additive assumption does not hold')
        return
      }
    }
  }
  const historicalWrap = (text, size, maxWidth) => {
    const lines = []
    let current = ''
    for (const ch of String(text)) {
      if (ch === '\n') { lines.push(current); current = ''; continue }
      const next = current + ch
      if (font.widthOfTextAtSize(next, size) > maxWidth && current) { lines.push(current); current = ch }
      else current = next
    }
    if (current) lines.push(current)
    return lines
  }
  for (const text of corpus) {
    assert.deepEqual(wrapToWidth(text, font, 10.5, 499), historicalWrap(text, 10.5, 499), text)
  }
  const fixed = new Date('2026-11-17T00:00:00Z')
  const paragraphs = corpus.slice(0, 20)
  const a = await buildSimplePdf({ title: '性能回归 · Advisers', paragraphs, createdAt: fixed })
  const b = await buildSimplePdf({ title: '性能回归 · Advisers', paragraphs, createdAt: fixed })
  assert.equal(a.subarray(0, 5).toString(), '%PDF-')
  assert.ok(a.equals(b), 'PDF output is deterministic for identical input (byte-for-byte)')
})

test('opening a database adds the secondary indexes without bumping schema v18', () => {
  const { root, home } = setup('indexes')
  try {
    const db = join(home, 'state.db')
    const store = new SqliteStore(db)
    const seed = new Ledger()
    const matter = seed.addMatter({ title: '索引' })
    store.save(seed.toJSON())
    for (const index of store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all()) {
      store.db.exec(`DROP INDEX ${index.name}`)
    }
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").get().n, 0)
    store.close()

    const reopened = new SqliteStore(db)
    try {
      const names = reopened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map((row) => row.name)
      for (const expected of [
        'idx_nudges_commitment_at', 'idx_nudges_local_day_level', 'idx_nudges_at',
        'idx_commitments_status_due', 'idx_facts_matter', 'idx_facts_status_deleted',
        'idx_preferences_status_expires', 'idx_calendar_events_starts',
        'idx_deliveries_created', 'idx_task_runs_created', 'idx_sessions_updated',
        'idx_model_calls_created',
      ]) assert.ok(names.includes(expected), `missing index ${expected}`)
      const plan = (sql, ...args) => reopened.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join(' ')
      assert.match(plan('SELECT * FROM nudges WHERE local_day = ? AND level = ?', '2026-11-17', 'L1'), /USING INDEX idx_nudges_local_day_level/)
      assert.match(plan('SELECT * FROM nudges WHERE commitment_id = ? ORDER BY at DESC LIMIT 3', 'cm_1'), /USING INDEX idx_nudges_commitment_at/)
      assert.match(plan('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT 20'), /idx_deliveries_created/)
      assert.equal(reopened.getMeta('schema_version'), String(SCHEMA_VERSION))
      assert.equal(SCHEMA_VERSION, 18, 'indexes are not a schema-version change')
      assert.ok(matter.id)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('batch nudge helpers keep the per-row addNudge/query semantics', () => {
  const { root, home } = setup('nudge-batch')
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    try {
      const day = '2026-11-17'
      assert.equal(store.addNudges([
        { localDay: day, level: 'L2', commitmentId: 'cm_a', body: 'a' },
        { localDay: day, level: 'L2', commitmentId: 'cm_b', body: 'b' },
        { localDay: day, level: 'L1', commitmentId: 'cm_c', body: 'c' },
      ]), 3)
      // Same dedupe keys as addNudge(): the second batch inserts nothing.
      assert.equal(store.addNudges([
        { localDay: day, level: 'L2', commitmentId: 'cm_a', body: 'a' },
        { localDay: day, level: 'L2', commitmentId: 'cm_b', body: 'b' },
      ]), 0)
      assert.equal(store.listNudges(10).length, 3)
      assert.equal(store.countNudges(day, 'L2'), 2)
      const byDay = store.countNudgesByDay(day)
      assert.equal(byDay.get('L2'), 2)
      assert.equal(byDay.get('L1'), 1)
      assert.deepEqual(store.listNudgeLevelKeysByDay(day), new Set([`cm_a\u0000L2`, `cm_b\u0000L2`, `cm_c\u0000L1`]))

      // recentNudgeOutcomes = the newest three rows per commitment, same as listCommitmentNudges.
      for (let i = 0; i < 4; i++) {
        const nudge = store.addNudge({ localDay: `2026-11-1${i}`, level: 'L2', commitmentId: 'cm_recent', body: `day${i}` })
        store.setNudgeOutcome(nudge.id, i === 3 ? 'ignored' : 'accepted')
        // addNudge() stamps the same millisecond for all four rows; give each a
        // deterministic timestamp so "newest three" is well defined.
        store.db.prepare('UPDATE nudges SET at = ? WHERE id = ?').run(`2026-11-1${i}T00:00:00.000Z`, nudge.id)
      }
      const recent = store.recentNudgeOutcomes(3)
      assert.deepEqual(recent.get('cm_recent'), ['ignored', 'accepted', 'accepted'])
      assert.deepEqual(recent.get('cm_recent'), store.listCommitmentNudges('cm_recent', 3).map((n) => n.outcome))
      assert.deepEqual(recent.get('cm_b'), ['pending'])

      assert.equal(store.listMetaByPrefix('snooze:').size, 0)
      store.setMeta('snooze:cm_a', '2026-11-18T00:00:00Z')
      store.setMeta('snooze:cm_b', '2026-11-19T00:00:00Z')
      store.setMeta('other:key', 'x')
      assert.deepEqual([...store.listMetaByPrefix('snooze:').keys()].sort(), ['snooze:cm_a', 'snooze:cm_b'])
      assert.equal(store.deleteMetaKeys(['snooze:cm_a', 'snooze:missing']), 1)
      assert.deepEqual([...store.listMetaByPrefix('snooze:').keys()], ['snooze:cm_b'])
      assert.ok(store.getMeta('other:key'))
    } finally {
      store.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
