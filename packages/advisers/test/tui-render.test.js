import assert from 'node:assert/strict'
import test from 'node:test'

import { ALLOWED_SGR_CODES, sgrCodes } from '../lib/tui/color.js'
import { DEFAULT_LABELS } from '../lib/tui/labels.js'
import {
  formatBytes,
  formatDuration,
  renderConfirm,
  renderError,
  renderResult,
  renderSnapshot,
  renderStatus,
} from '../lib/tui/render.js'
import { hasUnsafeDisplayChars } from '../lib/tui/sanitize.js'
import { graphemes, strWidth } from '../lib/tui/width.js'

const ESC = '\u001b'

function singleClusterOverflow(lines, width) {
  return lines.filter((line) => strWidth(line) > width).every((line) => graphemes(line).length === 1)
}

const ADVERSARIAL = {
  prompt: '帮我把王工的报价改成 85 折，重出 docx，这是一句很长很长的指令需要截断',
  headline: ESC + '[31m王工 · 活跃 · 2 个项目 · 保密 0' + ESC + '[39m 一个特别长的身份行用来测试折行',
  lines: [
    { role: 'fact', text: '欠他 2 件：11-24 发修订报价' + ESC + ']0;PWNED' + '\u0007；未排期 补一版范围说明' },
    { role: 'item', text: '最近：11-17 交付 报价确认单' },
    { role: 'warning', text: '外部内容已按数据处理' },
    { role: 'next', text: 'advisers client timeline cl_wang' },
  ],
  artifacts: [{ path: 'out/一个非常长的目录名字/王工-报价-2026-11-19-最终修订版.docx', bytes: 23961, verified: true }],
  checks: ['结构通过（内容未逐字核对）'],
  warnings: ['第一警告', '第二警告'],
  next: '打开确认；要改哪段直接说',
  tools: [{ name: 'office.generate', ok: true }, { name: 'fs.write', ok: false }],
  durationMs: 1234,
}

test('renderStatus returns one bounded line per kind', () => {
  const cases = [
    { kind: 'idle', today: { due: 2, overdue: 1 }, model: 'deepseek-flash' },
    { kind: 'idle', local: true },
    { kind: 'busy', seconds: 3 },
    { kind: 'confirm' },
    { kind: 'error', reason: '同步邮件（work）' },
    { kind: 'offline' },
  ]
  for (const status of cases) {
    for (const width of [40, 60, 80, 200]) {
      const line = renderStatus(status, { width })
      assert.equal(typeof line, 'string')
      assert.ok(!line.includes('\n'), 'status is one line')
      assert.ok(strWidth(line) <= Math.max(40, width), 'status fits: ' + width + ' ' + JSON.stringify(line))
      assert.equal(hasUnsafeDisplayChars(line), false)
    }
  }
})

test('renderStatus shows the exact 0.3.0 status vocabulary', () => {
  assert.equal(
    renderStatus({ kind: 'idle', today: { due: 2, overdue: 1 }, model: 'deepseek-flash' }, { width: 80 }),
    '* 就绪 · 今天 2 件到期 / 1 件逾期 · deepseek-flash · /help',
  )
  assert.equal(renderStatus({ kind: 'busy', seconds: 3 }, { width: 80 }), '~ 工作中 3s · Esc 中断')
  assert.equal(renderStatus({ kind: 'confirm' }, { width: 80 }), '! 待确认 · y 写入 / n 取消（默认 n）')
  assert.equal(renderStatus({ kind: 'error', reason: '同步邮件（work）' }, { width: 80 }), '! 上次失败：同步邮件（work） · /retry')
  assert.equal(renderStatus({ kind: 'idle', local: true }, { width: 80 }), '* 就绪 · 本地模式 · /help')
  assert.equal(renderStatus({ kind: 'idle', today: { due: 0, overdue: 0 } }, { width: 80 }), '* 就绪 · 今天没有到期项 · /help')
  assert.equal(renderStatus({ kind: 'busy' }, { width: 80 }), '~ 工作中 · Esc 中断')
})

test('renderStatus degrades right-to-left but never hides a failure signal', () => {
  const degraded = renderStatus({ kind: 'idle', today: { due: 2, overdue: 1 }, model: 'deepseek-flash' }, { width: 40 })
  assert.equal(degraded, '* 就绪 · 今天 2 件到期 / 1 件逾期')
  const offline = renderStatus({ kind: 'offline' }, { width: 40 })
  assert.match(offline, /模型不可达/)
  assert.ok(!offline.includes('就绪'), 'the health claim is dropped, not the offline signal')
  const error = renderStatus({ kind: 'error', reason: '网络不可达' }, { width: 40 })
  assert.match(error, /上次失败/)
})

test('renderStatus sanitises untrusted reason/hint text', () => {
  const line = renderStatus({ kind: 'error', reason: ESC + '[2J' + ESC + ']0;PWNED' + '\u0007用户名' }, { width: 80, accessible: true })
  assert.equal(hasUnsafeDisplayChars(line), false)
  assert.ok(!line.includes('PWNED'))
  assert.match(line, /用户名/)
  const hint = renderStatus({ kind: 'idle', hint: 'a' + ESC + '[31mb' + '\u0007' }, { width: 80 })
  assert.equal(hasUnsafeDisplayChars(hint), false)
})

test('renderStatus accessible mode uses [状态] and never emits ANSI', () => {
  const line = renderStatus({ kind: 'idle', today: { due: 1, overdue: 0 }, model: 'deepseek-flash' }, { width: 80, accessible: true, color: true })
  assert.match(line, /^\[状态\] 就绪/)
  assert.ok(!line.includes(ESC), 'accessible implies no SGR even when color is requested')
})

test('renderStatus colour uses the 16-colour whitelist', () => {
  for (const status of [{ kind: 'idle' }, { kind: 'busy', seconds: 1 }, { kind: 'confirm' }, { kind: 'error', reason: 'x' }, { kind: 'offline' }]) {
    const line = renderStatus(status, { width: 80, color: true })
    const codes = sgrCodes(line)
    assert.ok(codes.length > 0)
    assert.ok(codes.every((code) => ALLOWED_SGR_CODES.includes(code)), JSON.stringify(codes))
  }
})

test('renderResult keeps the stable prefix and block order', () => {
  const lines = renderResult({
    prompt: '看一下王工现在到哪一步',
    headline: '王工 · 活跃',
    lines: [{ role: 'item', text: '最近：11-17 交付' }, { role: 'check', text: '结构通过' }],
    artifacts: [{ path: 'out/a.docx', bytes: 1024, verified: null }],
    checks: ['内容未逐字核对'],
    warnings: ['w'],
    next: 'advisers client show cl_wang',
  }, { width: 80 })
  assert.ok(lines[0].startsWith('> '), 'user prefix')
  assert.ok(lines[1].startsWith('  '), 'headline indent')
  assert.ok(lines[2].startsWith('  - '), 'item prefix')
  assert.ok(lines[3].startsWith('  校验：'), 'check prefix')
  assert.ok(lines[4].startsWith('  文件：'), 'artifact prefix')
  assert.ok(lines[5].startsWith('  校验：'), 'checks list prefix')
  assert.ok(lines[6].startsWith('  ! '), 'warning prefix')
  assert.ok(lines[7].startsWith('  下一步：'), 'next prefix')
  assert.equal(lines[0], '> 看一下王工现在到哪一步')
  assert.equal(lines[1], '  王工 · 活跃')
  assert.equal(lines[2], '  - 最近：11-17 交付')
  assert.equal(lines[3], '  校验：结构通过')
  assert.equal(lines[4], '  文件：out/a.docx（1 KB）')
  assert.equal(lines[5], '  校验：内容未逐字核对')
  assert.equal(lines[6], '  ! w')
  assert.equal(lines[7], '  下一步：advisers client show cl_wang')
})

test('renderResult truncates the prompt to a single bounded line', () => {
  const long = '帮我把王工的报价改成 85 折，重出 docx，'.repeat(10)
  const lines = renderResult({ prompt: long }, { width: 40 })
  assert.equal(lines.length, 1)
  assert.ok(strWidth(lines[0]) <= 40)
  assert.match(lines[0], /…$/)
})

test('renderResult folds summary lines and never drops them silently', () => {
  const summary = '这是一段需要折叠的长总结。'.repeat(12)
  const lines = renderResult({ summary }, { width: 40, maxLines: 5 })
  assert.equal(lines.length, 6)
  assert.equal(lines[5], '  …（+4 行，/more 或 --json 查看）')
  const under = renderResult({ summary: '短总结' }, { width: 40, maxLines: 5 })
  assert.deepEqual(under, ['  短总结'])
})

test('renderResult caps items and reports the overflow', () => {
  const lines = renderResult({ lines: Array.from({ length: 11 }, (_, index) => ({ role: 'item', text: '第 ' + (index + 1) + ' 条' })) }, { width: 40 })
  assert.equal(lines.filter((line) => line.startsWith('  - ')).length, 8)
  assert.equal(lines[lines.length - 1], '  …（+3 条，/more 或 --json 查看）')
})

test('renderResult displays at most one warning line plus a count', () => {
  const lines = renderResult({ warnings: ['第一警告', '第二警告', '第三警告'] }, { width: 80 })
  assert.equal(lines.filter((line) => line.startsWith('  ! ')).length, 1)
  assert.equal(lines[0], '  ! 第一警告（+2 条）')
})

test('renderResult formats artifacts and middle-truncates long paths', () => {
  const wide = renderResult({ artifacts: [{ path: 'out/very-long-directory-name/王工-报价-2026-11-19-最终修订版.docx', bytes: 23961, verified: true }] }, { width: 40 })
  assert.ok(strWidth(wide[0]) <= 40)
  assert.match(wide[0], /…/)
  assert.match(wide[0], /23.4 KB/)
  assert.match(wide[0], /结构通过/)
  const failed = renderResult({ artifacts: [{ path: 'x', verified: false }] }, { width: 80 })
  assert.equal(failed[0], '  文件：x（校验失败）')
})

test('renderError emits reason/kept/next/code in order', () => {
  const lines = renderError({ title: '同步邮件（work）', reason: '游标失效', kept: '本地队列 3 封', next: 'advisers mail sync work --full', code: 'E_IMAP_UIDVALIDITY' }, { width: 80 })
  assert.deepEqual(lines, [
    '! 没做成：同步邮件（work）',
    '  原因：游标失效',
    '  已保留：本地队列 3 封',
    '  下一步：advisers mail sync work --full',
    '  代码：E_IMAP_UIDVALIDITY',
  ])
  const bold = renderError({ title: 'x', reason: 'y' }, { width: 80, color: true })
  assert.ok(sgrCodes(bold.join('\n')).every((code) => ALLOWED_SGR_CODES.includes(code)))
})

test('renderConfirm defaults to No and renders the consequence fields', () => {
  const lines = renderConfirm({ title: '写入账本', reason: '引用逐字命中', write: '1 条承诺', summary: 'sha256 abc…' }, { width: 80 })
  assert.deepEqual(lines, [
    '! 需要确认：写入账本',
    '  原因：引用逐字命中',
    '  写入：1 条承诺',
    '  摘要：sha256 abc…',
    '  y 写入 / n 取消（默认 n）',
  ])
  assert.ok(lines[lines.length - 1].includes('默认 n'))
})

test('renderSnapshot renders a read-only snapshot with bounded lines', () => {
  const lines = renderSnapshot({ title: 'Advisers TUI', sections: [{ heading: 'Today', lines: ['2 due'] }, { heading: 'Open', lines: [] }] }, { width: 40 })
  assert.deepEqual(lines, ['Advisers TUI', '', 'Today', '  2 due', '', 'Open'])
})

test('all renderers meet width/safety invariants across widths for adversarial input', () => {
  for (const width of [40, 80, 200]) {
    const outputs = [
      ...renderResult(ADVERSARIAL, { width, verbose: true }),
      ...renderError({ title: '同步邮件（work）', reason: '服务器 UIDVALIDITY 变了，本地游标不再可信', kept: '本地队列 3 封；没有删邮件、没有写账本', next: 'advisers mail sync work --full', code: 'E_IMAP_UIDVALIDITY' }, { width }),
      ...renderConfirm({ title: '把候选 cand_123 写入账本（王工 / 发修订报价）', reason: '邮件「Re: 报价」11-17 10:02，引用逐字命中', write: '1 条承诺 + 1 条证据；不发邮件、不改客户', summary: 'sha256 3f9a1c2e77aa…' }, { width }),
      renderStatus({ kind: 'idle', today: { due: 2, overdue: 1 }, model: 'deepseek-flash' }, { width }),
    ]
    for (const line of outputs) {
      assert.ok(strWidth(line) <= width || graphemes(line).length === 1, 'width ' + width + ': ' + JSON.stringify(line))
      assert.equal(hasUnsafeDisplayChars(line), false, 'unsafe: ' + JSON.stringify(line))
    }
    assert.ok(!outputs.join('\n').includes(ESC), 'no ANSI when colour is off')
  }
})

test('renderers are pure: same input produces the same output and input is unchanged', () => {
  const input = { headline: '完成', lines: [{ role: 'item', text: '甲' }], next: 'x' }
  const snapshot = JSON.stringify(input)
  assert.deepEqual(renderResult(input, { width: 80 }), renderResult(input, { width: 80 }))
  assert.equal(JSON.stringify(input), snapshot)
})

test('custom labels decouple display words from render logic', () => {
  const labels = {
    ...DEFAULT_LABELS,
    indent: '  ',
    userPrefix: '> ',
    itemPrefix: '  * ',
    filePrefix: '  file: ',
    checkPrefix: '  check: ',
    warningPrefix: '  ! ',
    nextPrefix: '  next: ',
    errorPrefix: '! failed: ',
    confirmPrefix: '! confirm: ',
    reasonPrefix: '  reason: ',
    keptPrefix: '  kept: ',
    writePrefix: '  write: ',
    summaryPrefix: '  summary: ',
    digestPrefix: '  digest: ',
    codePrefix: '  code: ',
    confirmPrompt: 'y / n (default n)',
    statusReady: 'ready',
    statusHelpHint: '/help',
    statusSeparator: ' | ',
    statusAccessiblePrefix: '[status] ',
  }
  const result = renderResult({ headline: 'done', lines: [{ role: 'item', text: 'one' }], checks: ['ok'], next: 'run' }, { width: 80, labels })
  assert.deepEqual(result, ['  done', '  * one', '  check: ok', '  next: run'])
  const status = renderStatus({ kind: 'idle', hint: '/help' }, { width: 80, labels })
  assert.equal(status, '* ready | /help')
})

test('formatBytes and formatDuration table', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(23961), '23.4 KB')
  assert.equal(formatBytes(1024 * 1024), '1 MB')
  assert.equal(formatBytes(undefined), '')
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(320), '320ms')
  assert.equal(formatDuration(1234), '1.2s')
  assert.equal(formatDuration(125000), '2m5s')
  assert.equal(formatDuration(undefined), '')
})

test('renderResult verbose mode adds tool lines and duration only when asked', () => {
  const block = { headline: '完成', tools: [{ name: 'a', ok: true }, { name: 'b', ok: false }], durationMs: 320 }
  assert.deepEqual(renderResult(block, { width: 80 }), ['  完成'])
  const verbose = renderResult(block, { width: 80, verbose: true })
  assert.deepEqual(verbose, ['  完成', '  · a ok', '  · b FAILED', '  耗时：320ms'])
})

