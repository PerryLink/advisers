import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCaptureCandidates, captureCandidates } from '../lib/capture.js'

test('capture keeps only verbatim quotes and valid due dates', () => {
  const text = '王工：周五前把报价发给我。我：好的，我周五前发。'
  const rows = validateCaptureCandidates([
    { action: '发报价', debtor: 'user', creditor: '王工', dueAt: '2026-11-14T10:00:00+08:00', quote: '我周五前发', modal: 'firm' },
    { action: '编造', debtor: 'user', quote: '我下周发' },
  ], text, { now: new Date('2026-11-12T10:00:00+08:00') })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, '发报价')
  // The model said 11-14 but "周五前" from Thursday 11-12 is Friday 11-13;
  // the deterministic date pass has to win over model arithmetic.
  assert.match(rows[0].dueAt, /2026-11-13/)
  assert.equal(rows[0].dueBasis, 'rule')
})

test('capture calls the model and returns structural candidates', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.reasoning_effort, 'high')
    assert.equal(body.thinking.type, 'enabled')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{ action: '发报价', debtor: 'user', creditor: '王工', dueAt: '2026-11-14T10:00:00+08:00', quote: '周五前发报价给王工', modal: 'firm', confidence: 0.9 }] }) } }], usage: { total_tokens: 1 } }), { status: 200 })
  }
  const result = await captureCandidates({ text: '周五前发报价给王工', apiKey: 'k', fetchImpl, now: new Date('2026-11-12T10:00:00+08:00') })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].creditor, '王工')
})

import { describeMessageTime, resolveRelativeDate } from '../lib/relative-date.js'
import { buildCapturePrompt } from '../lib/capture.js'

const localDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso))

test('capture prompt uses Asia/Shanghai wall clock, never the raw UTC date', () => {
  // 00:30 Beijing = 16:30Z on the previous day: the old prompt showed the
  // previous UTC date while claiming Asia/Shanghai.
  const prompt = buildCapturePrompt('我周五前发', { date: new Date('2026-11-13T00:30:00+08:00') })
  assert.match(prompt, /消息时间：2026-11-13 00:30 周五（Asia\/Shanghai）/)
  assert.ok(!prompt.includes('2026-11-12T16:30'))
  assert.match(prompt, /今天是 2026-11-13（周五）/)
  assert.match(describeMessageTime(new Date('2026-11-13T00:30:00+08:00')).date, /2026-11-13/)
})

test('relative dates resolve against the message date (Asia/Shanghai)', () => {
  const base = new Date('2026-11-12T10:00:00+08:00') // Thursday
  const cases = [
    ['今天', '2026-11-12'],
    ['明天发', '2026-11-13'],
    ['后天发', '2026-11-14'],
    ['大后天发', '2026-11-15'],
    ['我周五前发', '2026-11-13'],
    ['下周一给报价', '2026-11-16'],
    ['周三前把合同发给他', '2026-11-18'],
    ['月底前', '2026-11-30'],
    ['本季度末', '2026-12-31'],
    ['今年底', '2026-12-31'],
    ['3 天后', '2026-11-15'],
    ['两周后', '2026-11-26'],
    ['11月13日', '2026-11-13'],
    ['2027 年 1 月 10 日前交付', '2027-01-10'],
    ['下个月底', '2026-12-31'],
    ['下下月底', '2027-01-31'],
    ['下下周一下午3点前', '2026-11-23'],
  ]
  for (const [text, expected] of cases) {
    assert.equal(resolveRelativeDate(text, base)?.date, expected, text)
  }
  assert.equal(resolveRelativeDate('我回头把报价发你', base), null)
  assert.equal(resolveRelativeDate('如果客户确认，我周三前发', base)?.date, '2026-11-18')
  assert.equal(resolveRelativeDate('周五下班前发', base)?.time, '18:00')
  assert.equal(resolveRelativeDate('下周一上午10点前发', base)?.time, '10:00')
  assert.equal(resolveRelativeDate('明天下午3点半发', base)?.time, '15:30')
})

test('same-day weekday and month-end are marked ambiguous, not dropped', () => {
  const friday = new Date('2026-11-13T09:00:00+08:00')
  const weekly = resolveRelativeDate('周五前发', friday)
  assert.equal(weekly?.date, '2026-11-13')
  assert.equal(weekly?.ambiguous, true)

  const monthEnd = resolveRelativeDate('月底前发', new Date('2026-11-30T09:00:00+08:00'))
  assert.equal(monthEnd?.date, '2026-11-30')
  assert.equal(monthEnd?.ambiguous, true)

  const nextWeek = resolveRelativeDate('下周一发', friday)
  assert.equal(nextWeek?.date, '2026-11-16')
  assert.equal(nextWeek?.ambiguous, false)
})

test('deterministic pass corrects model arithmetic and fills missing dueAt', () => {
  const base = new Date('2026-11-12T10:00:00+08:00')
  const wrongDate = '2026-11-20T10:00:00+08:00' // model thought "下周一" was next Friday
  const corrected = validateCaptureCandidates([
    { action: '发报价', debtor: 'user', quote: '下周一前把报价发我', dueAt: wrongDate, modal: 'firm' },
  ], '王工：下周一前把报价发我。', { now: base })
  assert.equal(localDate(corrected[0].dueAt), '2026-11-16')
  assert.equal(corrected[0].dueBasis, 'rule')

  const filled = validateCaptureCandidates([
    { action: '发报价', debtor: 'user', quote: '我周五前发', dueAt: null, modal: 'firm' },
  ], '王工：周五前把报价发我。我：好的，我周五前发。', { now: base })
  assert.equal(localDate(filled[0].dueAt), '2026-11-13')

  const explicit = validateCaptureCandidates([
    { action: '交付报价', debtor: 'third', quote: '2027 年 1 月 10 日前交付报价', dueAt: null, modal: 'firm' },
  ], '乙方应于 2027 年 1 月 10 日前交付报价。', { now: base })
  assert.equal(localDate(explicit[0].dueAt), '2027-01-10')
})

test('conflicting date expressions fall back to a valid model dueAt', () => {
  const base = new Date('2026-11-12T10:00:00+08:00')
  const rows = validateCaptureCandidates([
    { action: '发报价', debtor: 'user', quote: '周五前发报价，下周一也要发', dueAt: '2026-11-16T10:00:00+08:00', modal: 'firm' },
  ], '周五前发报价，下周一也要发', { now: base })
  assert.equal(localDate(rows[0].dueAt), '2026-11-16')
  assert.equal(rows[0].dueBasis, 'model')
})

test('"当天" is not resolved as the message day (gold-review finding)', () => {
  // "当天" usually refers to a previously mentioned event day, not the message
  // day. Overriding the model with the message date would be wrong; the rule
  // pass must keep a valid model dueAt instead.
  const base = new Date('2026-11-13T10:00:00+08:00')
  assert.equal(resolveRelativeDate('当天下午前完成', base), null)
  const rows = validateCaptureCandidates([
    { action: '完成演练', debtor: 'user', quote: '当天下午前完成', dueAt: '2026-11-17T10:00:00+08:00', modal: 'firm' },
  ], '演练当天下午前完成', { now: base })
  assert.equal(localDate(rows[0].dueAt), '2026-11-17')
  assert.equal(rows[0].dueBasis, 'model')
})
