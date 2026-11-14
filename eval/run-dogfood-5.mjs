#!/usr/bin/env node
/**
 * eval/run-dogfood-5.mjs — 5-persona dogfood runner (offline-reviewable).
 *
 * 目标不是再做一组 agent 评测，而是检查“同一个 ADVISERS_HOME 被连续使用时”：
 *   - 承诺账 / 显式偏好 / 交付物会不会跨会话丢失或互相污染；
 *   - T1 写入的承诺，能否在**新进程**的 today / tick 里看到；
 *   - capture 候选是否保持 pending（不自动 confirmed / 不自动入账），
 *     人工 `memory accept` 后才进入承诺账；
 *   - 5 个 persona 各自独立的 home/work 之间是否真的隔离（客户名、偏好、
 *     承诺、交付物都不串门）；
 *   - office 生成的交付物能否通过 `verify --content`，并出现在 deliveries/receipt。
 *
 * 5 个 persona（全部为合成画像与合成客户，非真实客户数据）：
 *   P1 独立咨询顾问（林知远） / P2 自由设计师（沈栖迟） / P3 小团队负责人（周时雨）
 *   P4 技术顾问（陆停云）   / P5 独立律师助理（顾青禾）
 * 每个 persona 3 个连续任务，共 15 个任务；同 persona 的任务共享同一 home/work，
 * 不同 persona 的 home/work 彼此独立（临时目录，finally 清理）。
 *
 * 用法：
 *   DRY_RUN=1 node eval/run-dogfood-5.mjs
 *       离线：只列出 15 个任务与命令，不执行 CLI、不需要 key、不建临时目录。
 *   PERSONAS=1,3,5 DRY_RUN=1 node eval/run-dogfood-5.mjs
 *       只列指定 persona 的任务（每个 persona 仍为 3 个任务）。
 *   ADVISERS_API_KEY=... node eval/run-dogfood-5.mjs
 *       真实模式：主脚本用 child_process 逐条调用本地 CLI（每个任务的新进程
 *       都算一次跨会话），由 CLI 调用真实模型；任一任务或隔离检查失败 exit 1。
 *   ADVISERS_NO_MODEL=1 node eval/run-dogfood-5.mjs
 *       “假的”无模型场景：真实模式需要真实 key，会立刻打印“需要真实 key”并 exit 1。
 *
 * 真实模型的执行归属：本脚本不内置模型，真实模式只是驱动本地 CLI；真实运行
 * 由外层主代理（有 key 的协调者）执行，不在 CI 里跑。离线验证只需
 * `node --check` + `DRY_RUN=1` + 无 key 快速失败路径。
 *
 * 输出契约：stdout 只输出一个 JSON 汇总
 *   { personas, tasks, passed, failed, results:[...], issues:[...], ... }
 * 进度写 stderr。每个任务记录 persona、task、命令、退出码、耗时、stdout 摘要
 * 与断言结果。临时目录在 finally 清理；任何输出里的 key 都会被 redact，绝不
 * 打印或落盘 key。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLI_TIMEOUT_MS = Number(process.env.DOGFOOD_CLI_TIMEOUT_MS) || 300_000
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '../packages/advisers/bin/advisers.js')
const DAY_MS = 86_400_000

/**
 * 相对日期一律按 Asia/Shanghai 的“本地日”生成。tick / today 也按上海时区
 * 计算本地日，避免跨午夜的 UTC 偏移把“今天/逾期”断言弄错。
 */
function shanghaiDay(offsetDays = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() + offsetDays * DAY_MS))
}

const TODAY = shanghaiDay(0)
const DUE = {
  overdue: shanghaiDay(-1),
  soon: shanghaiDay(2),
  later: shanghaiDay(5),
  far: shanghaiDay(6),
}

// ---------------------------------------------------------------------------
// 通用小工具（断言 / 输出 / 命令拼接）
// ---------------------------------------------------------------------------

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: String(detail ?? '') }
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function checkText(text) {
  return normalize(text)
}

function redact(text) {
  let value = String(text ?? '')
  for (const key of [process.env.ADVISERS_API_KEY, process.env.DEEPSEEK_API_KEY].filter(Boolean)) {
    value = value.split(key).join('[redacted]')
  }
  return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

function summarize(text, limit = 320) {
  return redact(normalize(text)).slice(0, limit)
}

function quoteArg(arg) {
  return /[\s"']/.test(String(arg)) ? JSON.stringify(String(arg)) : String(arg)
}

function formatCommand(argv) {
  return `advisers ${argv.map(quoteArg).join(' ')}`
}

function dryCommand(step) {
  if (typeof step.argv === 'function') return `advisers ${step.dry || '<dynamic>'}`
  return formatCommand(step.argv)
}
function parseJson(text) {
  try {
    return JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
}

function findLine(text, token) {
  if (!token) return ''
  return String(text ?? '').split('\n').find((line) => line.includes(token)) ?? ''
}

function lines(text) {
  return String(text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0)
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stepRun(stepRuns, label) {
  return [...stepRuns].reverse().find((run) => run.label === label)
}

function firstValue(text, re) {
  return re.exec(String(text ?? ''))?.[1] ?? ''
}

function candidateAction(stdout, candidateId) {
  if (!candidateId) return ''
  for (const line of String(stdout ?? '').split('\n')) {
    const parts = line.split('\t')
    if (parts[0] !== candidateId) continue
    try {
      return String(JSON.parse(parts[2])?.action || '')
    } catch {
      return ''
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 任务工厂：15 个任务由 4 类工厂生成，断言与命令一一对应。
//
// 任务步骤字段：
//   label      进度/断言里用的稳定名字
//   argv       静态参数数组，或 (state) => 参数数组
//   dry        argv 为函数时，DRY_RUN 展示用的命令正文（不含 "advisers "）
//   collect    { name, re }：从该步 stdout 提取状态（如承诺 id / 候选 id）
//   expectExit 允许的退出码，默认 [0]；review 允许 [0, 1]
// 断言通过 stepRuns（含原始 stdout）与 state 检查；executor 已统一检查退出码。
// ---------------------------------------------------------------------------

function makeCommitTask(persona, { id, title, commitments, preference }) {
  const steps = commitments.map((commitment, index) => ({
    label: `记录承诺 ${index + 1}：${commitment.action}`,
    argv: ['commit', 'add', commitment.action, '--quote', commitment.quote, '--due', commitment.due, '--creditor', commitment.creditor],
    collect: { name: `commitment${index + 1}`, re: /(cm_[A-Za-z0-9_]+)/ },
  }))
  steps.push(
    { label: '写入显式偏好', argv: ['correct', preference] },
    { label: '回看承诺账', argv: ['commit', 'ls'] },
    { label: '回看偏好', argv: ['prefs'] },
    { label: '导出账本', argv: ['export'] },
  )

  return {
    id,
    personaId: persona.id,
    kind: 'commitments',
    title,
    assertions: [
      `${commitments.length} 条 commit add 退出码 0 且返回 cm_ 承诺 id`,
      'commit ls 中两条承诺均为 open（记录承诺不等于完成，也不自动 confirmed）',
      'prefs 中显式偏好为 confirmed（来自 correct，不是推断）',
      'export 中只有一个 matter，所有承诺挂同一 matter，且无 confirmed 状态承诺',
    ],
    steps,
    async assert(ctx, { stepRuns }) {
      const checks = []
      const lsRun = stepRun(stepRuns, '回看承诺账')
      const prefsRun = stepRun(stepRuns, '回看偏好')
      const exportRun = stepRun(stepRuns, '导出账本')

      for (const commitment of commitments) {
        const line = findLine(lsRun?.stdout, commitment.action)
        checks.push(check(`commit ls 可见承诺「${commitment.action}」`, Boolean(line), line || 'missing'))
        if (line) {
          const status = line.split('\t')[1] || ''
          checks.push(check(`承诺「${commitment.action}」为 open`, status === 'open', `status=${status || '?'}`))
        }
      }

      const prefsOut = prefsRun?.stdout ?? ''
      const prefLine = findLine(prefsOut, preference)
      checks.push(check(`prefs 可见显式偏好「${preference}」`, Boolean(prefLine), prefLine || summarize(prefsOut)))
      checks.push(check('prefs 中该偏好为 confirmed', /\tconfirmed\t/.test(prefLine), prefLine || 'missing'))

      const ledger = parseJson(exportRun?.stdout)
      if (!ledger) {
        checks.push(check('export 是合法 JSON', false, summarize(exportRun?.stdout)))
        return checks
      }
      const matters = ledger.matters ?? []
      const rows = ledger.commitments ?? []
      const prefs = ledger.preferences ?? []
      checks.push(check('export 中承诺条数正确', rows.length === commitments.length, `${rows.length}/${commitments.length}`))
      checks.push(check('export 中 matter 唯一', matters.length === 1, `${matters.length} matter(s)`))
      checks.push(check('export 中承诺全部为 open', rows.length > 0 && rows.every((row) => row.status === 'open'), rows.map((row) => row.status).join(',')))
      checks.push(check('export 中没有承诺被自动标成 confirmed', rows.every((row) => row.status !== 'confirmed'), rows.map((row) => row.status).join(',')))
      checks.push(check('承诺都挂在本 home 的同一 matter', rows.length > 0 && matters[0] && rows.every((row) => row.matterId === matters[0].id), rows.map((row) => row.matterId).join(',') || 'no rows'))
      const pref = prefs.find((entry) => entry.statement === preference)
      checks.push(check('export 中显式偏好为 confirmed', pref?.status === 'confirmed', pref ? `${pref.id}/${pref.status}/conf=${pref.confidence}` : 'missing'))
      return checks
    },
  }
}

function makeContinuityTask(persona, { id, title, firstAction, secondAction, mutate = 'none', expectOverdue = false }) {
  const firstIdRe = new RegExp(`^(cm_[A-Za-z0-9_]+)\\t[^\\n]*${escapeRegExp(firstAction)}`, 'm')
  const steps = [
    { label: '跨会话读取承诺账', argv: ['commit', 'ls'], collect: { name: 'firstId', re: firstIdRe } },
    { label: '新进程 today（变更前）', argv: ['today'] },
    { label: '新进程 tick（变更前）', argv: ['tick', '--json'] },
  ]
  if (mutate === 'done') {
    steps.push({
      label: '带证据标记完成',
      argv: (state) => ['commit', 'done', state.firstId, '--evidence', '已完成，邮件已确认'],
      dry: 'commit done <第一次承诺 id> --evidence "已完成，邮件已确认"',
    })
  } else if (mutate === 'snooze') {
    steps.push({
      label: '稍后提醒 24 小时',
      argv: (state) => ['commit', 'snooze', state.firstId, '24'],
      dry: 'commit snooze <第一次承诺 id> 24',
    })
  }
  steps.push(
    { label: '新进程 today（变更后）', argv: ['today'] },
    { label: '新进程 tick（变更后）', argv: ['tick', '--json'] },
    { label: '新进程 commit ls（变更后）', argv: ['commit', 'ls'] },
  )
  if (expectOverdue) steps.push({ label: '新进程 who（欠账视图）', argv: ['who'] })

  return {
    id,
    personaId: persona.id,
    kind: 'cross-session',
    title,
    dependsOn: [],
    assertions: [
      '新进程 commit ls/today/tick 能看到上一个进程写入的两条承诺（同一 home 持久化）',
      'today 输出包含今日概览行，tick --json 给出 L1/L2 提醒等级',
      expectOverdue ? 'today 逾期计数 ≥1，tick 至少一条 L2' : 'tick 按 due 给出提醒等级',
      mutate === 'done'
        ? '带证据 done 后 today/tick/commit ls 同步隐藏或标记完成，另一条仍在'
        : mutate === 'snooze'
          ? 'snooze 后 today/tick 隐藏该条，commit ls 保留 snoozed，另一条仍在'
          : '未变更的承诺保持 open，today/tick 均可见',
    ],
    steps,
    async assert(ctx, { stepRuns, state, persona: runtimePersona }) {
      const checks = []
      const beforeLs = stepRun(stepRuns, '跨会话读取承诺账')
      const beforeToday = stepRun(stepRuns, '新进程 today（变更前）')
      const beforeTick = parseJson(stepRun(stepRuns, '新进程 tick（变更前）')?.stdout)

      checks.push(check('跨会话从 commit ls 重新读到第一次承诺 id', Boolean(state.firstId), state.firstId || 'missing'))
      checks.push(check('today 看到第一次承诺', (beforeToday?.stdout ?? '').includes(firstAction), summarize(beforeToday?.stdout)))
      checks.push(check('today 看到第二次承诺', (beforeToday?.stdout ?? '').includes(secondAction), summarize(beforeToday?.stdout)))
      checks.push(check('today 输出包含今日概览行', /今天：\d+ · 逾期：\d+ · 未来 7 天：\d+/.test(beforeToday?.stdout ?? ''), summarize(beforeToday?.stdout)))

      if (beforeTick) {
        const due = beforeTick.due ?? []
        checks.push(check('tick --json 可解析且 due 数组存在', Array.isArray(beforeTick.due), `due=${due.length}`))
        checks.push(check('tick due 包含两次承诺', [firstAction, secondAction].every((action) => due.some((entry) => entry.action === action)), due.map((entry) => entry.action).join(' | ')))
        checks.push(check('tick 每条都有提醒等级', due.length > 0 && due.every((entry) => ['L1', 'L2', 'L3'].includes(entry.level)), due.map((entry) => entry.level).join(',')))
        if (expectOverdue) {
          checks.push(check('tick 至少一条 L2（逾期/今天到期）', due.some((entry) => entry.level === 'L2'), due.map((entry) => `${entry.action}:${entry.level}`).join(' | ')))
        }
      } else {
        checks.push(check('tick --json 可解析', false, summarize(stepRun(stepRuns, '新进程 tick（变更前）')?.stdout)))
      }

      if (expectOverdue) {
        const overdue = Number(firstValue(beforeToday?.stdout, /逾期：(\d+)/) || -1)
        checks.push(check('today 逾期计数 ≥ 1', overdue >= 1, `逾期=${overdue}`))
      }

      const afterToday = stepRun(stepRuns, '新进程 today（变更后）')
      const afterTickRun = stepRun(stepRuns, '新进程 tick（变更后）')
      const afterTick = parseJson(afterTickRun?.stdout)
      const afterLs = stepRun(stepRuns, '新进程 commit ls（变更后）')
      const afterLsOut = afterLs?.stdout ?? ''

      if (afterTick) {
        const due = afterTick.due ?? []
        if (mutate === 'done') {
          const doneRun = stepRun(stepRuns, '带证据标记完成')
          checks.push(check('commit done 返回 done:', (doneRun?.stdout ?? '').trim().startsWith('done:'), summarize(doneRun?.stdout)))
          checks.push(check('完成后 today 不再显示第一次承诺', !(afterToday?.stdout ?? '').includes(firstAction), summarize(afterToday?.stdout)))
          checks.push(check('完成后 today 仍显示第二次承诺', (afterToday?.stdout ?? '').includes(secondAction), summarize(afterToday?.stdout)))
          checks.push(check('完成后 tick 不再包含第一次承诺', !due.some((entry) => entry.action === firstAction), due.map((entry) => entry.action).join(' | ')))
          checks.push(check('完成后 tick 仍包含第二次承诺', due.some((entry) => entry.action === secondAction), due.map((entry) => entry.action).join(' | ')))
          checks.push(check('完成后 commit ls 第一次承诺为 done', (findLine(afterLsOut, firstAction).split('\t')[1] || '') === 'done', findLine(afterLsOut, firstAction) || 'missing'))
          checks.push(check('完成后第二次承诺仍 open', (findLine(afterLsOut, secondAction).split('\t')[1] || '') === 'open', findLine(afterLsOut, secondAction) || 'missing'))
        } else if (mutate === 'snooze') {
          const snoozeRun = stepRun(stepRuns, '稍后提醒 24 小时')
          checks.push(check('commit snooze 返回 snoozed:', (snoozeRun?.stdout ?? '').trim().startsWith('snoozed:'), summarize(snoozeRun?.stdout)))
          checks.push(check('snooze 后 today 隐藏第一次承诺', !(afterToday?.stdout ?? '').includes(firstAction), summarize(afterToday?.stdout)))
          checks.push(check('snooze 后 today 仍显示第二次承诺', (afterToday?.stdout ?? '').includes(secondAction), summarize(afterToday?.stdout)))
          checks.push(check('snooze 后 tick 不再包含第一次承诺', !due.some((entry) => entry.action === firstAction), due.map((entry) => entry.action).join(' | ')))
          checks.push(check('snooze 后 tick 仍包含第二次承诺', due.some((entry) => entry.action === secondAction), due.map((entry) => entry.action).join(' | ')))
          checks.push(check('snooze 后 commit ls 第一次承诺为 snoozed', (findLine(afterLsOut, firstAction).split('\t')[1] || '') === 'snoozed', findLine(afterLsOut, firstAction) || 'missing'))
          checks.push(check('snooze 后第二次承诺仍 open', (findLine(afterLsOut, secondAction).split('\t')[1] || '') === 'open', findLine(afterLsOut, secondAction) || 'missing'))
        } else {
          checks.push(check('未变更时 tick 仍包含两次承诺', [firstAction, secondAction].every((action) => due.some((entry) => entry.action === action)), due.map((entry) => entry.action).join(' | ')))
          checks.push(check('未变更时两次承诺仍为 open', [firstAction, secondAction].every((action) => (findLine(afterLsOut, action).split('\t')[1] || '') === 'open'), summarize(afterLsOut)))
          checks.push(check('未变更时今日概览仍有今晚/近期条目', /今天：\d+ · 逾期：\d+ · 未来 7 天：\d+/.test(afterToday?.stdout ?? ''), summarize(afterToday?.stdout)))
        }
      } else {
        checks.push(check('变更后 tick --json 可解析', false, summarize(afterTickRun?.stdout)))
      }

      if (expectOverdue) {
        const whoRun = stepRun(stepRuns, '新进程 who（欠账视图）')
        checks.push(check('who 列出第一次承诺', (whoRun?.stdout ?? '').includes(firstAction), summarize(whoRun?.stdout)))
        checks.push(check('who 列出第二次承诺', (whoRun?.stdout ?? '').includes(secondAction), summarize(whoRun?.stdout)))
      }

      checks.push(check('跨进程共用同一 home 的 SQLite 文件', existsSync(join(runtimePersona.home, 'state.db')), 'state.db'))
      return checks
    },
  }
}

function makeOfficeTask(persona, { id, title, kind, specPath, spec, outPath, minEntries, tokens, slideCount }) {
  const steps = [
    { label: '生成交付物', argv: ['office', kind, specPath, outPath] },
    { label: '结构+内容校验', argv: ['verify', outPath, '--content'] },
    { label: '读取交付物文本', argv: ['office-read', outPath] },
    { label: '交付记录', argv: ['deliveries'] },
    { label: '交付回执', argv: ['receipt'] },
    { label: '导出账本', argv: ['export'] },
  ]
  return {
    id,
    personaId: persona.id,
    kind: 'office',
    title,
    dependsOn: [],
    fixtures: [{ path: specPath, content: `${JSON.stringify(spec, null, 2)}\n` }],
    assertions: [
      `office ${kind} 退出码 0，交付物文件存在且非空`,
      'verify --content 的 structure.ok 与 content.ok 均为 true，OPC/XML/rels 层齐全',
      `office-read 文本包含 ${tokens.map((token) => `「${token}」`).join('、')}`,
      slideCount ? `office-read 至少 ${slideCount} 页（[[slideN]] 标记）` : '交付物可解析出文本',
      'deliveries / receipt 记录本次交付，receipt 的未完成承诺数与账本一致',
    ],
    steps,
    async assert(ctx, { stepRuns }) {
      const checks = []
      const abs = join(ctx.personaWork(persona.id), outPath)
      const exists = existsSync(abs)
      checks.push(check(`交付物存在：${outPath}`, exists, exists ? `${statSync(abs).size} bytes` : 'missing'))
      if (exists) checks.push(check(`交付物非空：${outPath}`, statSync(abs).size > 1000, `${statSync(abs).size} bytes`))

      const verifyRun = stepRun(stepRuns, '结构+内容校验')
      const verify = parseJson(verifyRun?.stdout)
      checks.push(check('verify --content 输出合法 JSON', Boolean(verify), summarize(verifyRun?.stdout)))
      if (verify) {
        const structure = verify.structure ?? {}
        const layers = structure.layers ?? []
        checks.push(check('verify structure.ok', structure.ok === true, `missing=${JSON.stringify(structure.missing ?? [])}`))
        checks.push(check('verify content.ok', verify.content?.ok === true, `blockers=${verify.content?.stats?.blockers ?? '?'}`))
        checks.push(check('verify 覆盖 OPC/XML/content-types/rels', ['opc', 'xml', 'content-types', 'rels'].every((layer) => layers.includes(layer)), layers.join(',')))
        checks.push(check(`verify 条目数 ≥ ${minEntries}`, (structure.entries ?? 0) >= minEntries, `${structure.entries ?? '?'} entries`))
      }

      const readRun = stepRun(stepRuns, '读取交付物文本')
      for (const token of tokens) {
        checks.push(check(`交付物文本含「${token}」`, (readRun?.stdout ?? '').includes(token), summarize(readRun?.stdout)))
      }
      if (slideCount) {
        const slides = ((readRun?.stdout ?? '').match(/\[\[slide\d+\]\]/g) || []).length
        checks.push(check(`交付物至少 ${slideCount} 页`, slides >= slideCount, `${slides} slide markers`))
      }

      const deliveriesRun = stepRun(stepRuns, '交付记录')
      checks.push(check('deliveries 记录本次交付文件', (deliveriesRun?.stdout ?? '').includes(outPath), summarize(deliveriesRun?.stdout)))
      checks.push(check('deliveries 记录 office 工具与 ok 校验', /\[office\][^\n]*"ok":true/.test(deliveriesRun?.stdout ?? ''), summarize(deliveriesRun?.stdout)))

      const receiptRun = stepRun(stepRuns, '交付回执')
      const ledger = parseJson(stepRun(stepRuns, '导出账本')?.stdout)
      const openCount = (ledger?.commitments ?? []).filter((row) => row.status === 'open').length
      checks.push(check('receipt 产物路径正确', (receiptRun?.stdout ?? '').includes(`产物：${outPath}`), summarize(receiptRun?.stdout)))
      checks.push(check('receipt 未完成承诺数与账本一致', (receiptRun?.stdout ?? '').includes(`未完成承诺：${openCount}`), `expected 未完成承诺：${openCount}`))
      if (ledger) checks.push(check('交付物只挂在本 home 的 1 个 matter', (ledger.matters ?? []).length === 1, `${(ledger.matters ?? []).length} matter(s)`))
      return checks
    },
  }
}

function makeReviewTask(persona, { id, title, fileRel, request }) {
  const steps = [
    { label: '审阅前读取交付物', argv: ['office-read', fileRel] },
    { label: '真实模型审阅（只读）', argv: ['review', fileRel, '--request', request], expectExit: [0, 1] },
    { label: '审阅后读取交付物', argv: ['office-read', fileRel] },
    { label: '审阅后结构校验', argv: ['verify', fileRel, '--content'] },
  ]
  return {
    id,
    personaId: persona.id,
    kind: 'review',
    title,
    dependsOn: [],
    assertions: [
      'review 允许 exit 0 或 1，但必须有可读输出且没有 Node 堆栈 / usage 错误',
      'exit 1 时输出必须确有 [blocker]；exit 0 时不得出现 [blocker]（输出与退出码自洽）',
      '审阅前后 office-read 文本完全一致（review 只读，不改交付物）',
      '审阅后 verify --content 仍然通过',
    ],
    steps,
    async assert(ctx, { stepRuns }) {
      const checks = []
      const before = stepRun(stepRuns, '审阅前读取交付物')
      const review = stepRun(stepRuns, '真实模型审阅（只读）')
      const after = stepRun(stepRuns, '审阅后读取交付物')
      const verify = parseJson(stepRun(stepRuns, '审阅后结构校验')?.stdout)

      checks.push(check('审阅前后交付物文本完全一致（只读）', normalize(before?.stdout) === normalize(after?.stdout), normalize(before?.stdout) === normalize(after?.stdout) ? 'identical' : 'changed'))
      const output = review?.stdout ?? ''
      checks.push(check('review 有可读输出', normalize(output).length >= 4, summarize(output)))
      const stack = /(^|\n)\s+at\s+[^\n]+:\d+:\d+/.test(`${output}\n${review?.stderr ?? ''}`)
      checks.push(check('review 输出没有 Node 堆栈', !stack, stack ? summarize(`${output} ${review?.stderr ?? ''}`) : 'ok'))
      const usage = /usage: advisers review|requires ADVISERS_API_KEY/.test(`${output}${review?.stderr ?? ''}`)
      checks.push(check('review 没有落到 usage/key 错误分支', !usage, usage ? summarize(`${output} ${review?.stderr ?? ''}`) : 'ok'))
      const blockers = /\[blocker\]/.test(output)
      if (review?.exitCode === 1) {
        checks.push(check('exit 1 时输出确有 [blocker]', blockers, summarize(output)))
        // 这是“记录但不判失败”的信息项：干净文档被模型报 blocker 是 dogfood
        // 需要留痕的发现，不应该让断言随机变红。
        checks.push(check('模型审阅报告了 blocker（仅记录，不判失败）', true, summarize(output, 240)))
      } else {
        checks.push(check('exit 0 时输出无 [blocker]', !blockers, summarize(output)))
      }
      checks.push(check('审阅后 verify structure/content 仍通过', verify?.structure?.ok === true && verify?.content?.ok === true, `structure=${verify?.structure?.ok} content=${verify?.content?.ok}`))
      return checks
    },
  }
}

function makeCaptureTask(persona, { id, title, text, source = 'meeting', preference }) {
  const steps = [
    { label: 'capture 抽取承诺候选', argv: ['capture', text, '--source', source, '--date', TODAY], collect: { name: 'candidateId', re: /^(cand_[A-Za-z0-9_]+)/m } },
    { label: '查看待确认候选', argv: ['memory', 'candidates'] },
    { label: 'accept 前查看承诺账', argv: ['commit', 'ls'] },
    { label: 'accept 前查看 today', argv: ['today'] },
    { label: '人工确认候选', argv: (state) => {
      if (!state.candidateId) throw new Error('capture 没有返回候选 id，无法进入人工确认流程')
      return ['memory', 'accept', state.candidateId]
    }, dry: 'memory accept <capture 候选 id>' },
    { label: 'accept 后查看承诺账', argv: ['commit', 'ls'] },
    { label: 'accept 后查看偏好', argv: ['prefs'] },
    { label: '导出账本+候选表', argv: ['export', '--all'] },
  ]
  return {
    id,
    personaId: persona.id,
    kind: 'capture',
    title,
    dependsOn: [],
    assertions: [
      'capture 退出码 0 并返回 cand_ 候选 id；memory candidates 中该候选为 pending',
      '人工 accept 之前，commit ls / today 都看不到候选 action（不自动入账、不自动 confirmed）',
      'memory accept 之后，commit ls 出现 open 承诺，export --all 中候选状态为 accepted',
      'capture/accept 不改变 prefs（候选不能污染偏好）',
    ],
    steps,
    async assert(ctx, { stepRuns, state }) {
      const checks = []
      const captureRun = stepRun(stepRuns, 'capture 抽取承诺候选')
      const candidateId = state.candidateId
      checks.push(check('capture 未落到缺 key 分支', !/requires ADVISERS_API_KEY/.test(`${captureRun?.stdout ?? ''}${captureRun?.stderr ?? ''}`), summarize(captureRun?.stdout)))
      checks.push(check('capture 返回 cand_ 候选 id', Boolean(candidateId), candidateId || summarize(captureRun?.stdout)))

      const candidatesRun = stepRun(stepRuns, '查看待确认候选')
      const pendingLine = findLine(candidatesRun?.stdout, candidateId)
      checks.push(check('memory candidates 显示该候选', Boolean(pendingLine), pendingLine || summarize(candidatesRun?.stdout)))
      checks.push(check('memory candidates 中候选为 pending', /\tpending\s*$/.test(pendingLine), pendingLine || 'missing'))

      const action = candidateAction(candidatesRun?.stdout, candidateId)
      checks.push(check('候选 action 非空', Boolean(action), action || 'missing'))
      if (action) {
        const beforeLs = stepRun(stepRuns, 'accept 前查看承诺账')
        const beforeToday = stepRun(stepRuns, 'accept 前查看 today')
        checks.push(check('accept 前承诺账没有该候选（不自动入账）', !(beforeLs?.stdout ?? '').includes(action), summarize(beforeLs?.stdout)))
        checks.push(check('accept 前 today 没有该候选（不自动 confirmed）', !(beforeToday?.stdout ?? '').includes(action), summarize(beforeToday?.stdout)))
      }

      const acceptRun = stepRun(stepRuns, '人工确认候选')
      checks.push(check('memory accept 返回 accepted', (acceptRun?.stdout ?? '').includes(`accepted ${candidateId}`), summarize(acceptRun?.stdout)))

      const afterLs = stepRun(stepRuns, 'accept 后查看承诺账')
      const afterLine = findLine(afterLs?.stdout, action)
      checks.push(check('accept 后 commit ls 可见新承诺', Boolean(afterLine), afterLine || summarize(afterLs?.stdout)))
      checks.push(check('accept 后新承诺为 open', (afterLine?.split('\t')[1] || '') === 'open', afterLine || 'missing'))

      const prefsRun = stepRun(stepRuns, 'accept 后查看偏好')
      const prefLines = lines(prefsRun?.stdout)
      checks.push(check('capture/accept 没有污染偏好', prefLines.length === 1 && prefLines[0].includes(preference), summarize(prefsRun?.stdout)))

      const exportRun = stepRun(stepRuns, '导出账本+候选表')
      const exported = parseJson(exportRun?.stdout)
      if (!exported) {
        checks.push(check('export --all 是合法 JSON', false, summarize(exportRun?.stdout)))
      } else {
        const candidateRow = (exported.data?.memory_candidates ?? []).find((row) => row.id === candidateId)
        checks.push(check('export --all 中候选状态为 accepted', candidateRow?.status === 'accepted', candidateRow?.status ?? 'missing'))
        const commitmentRows = exported.ledger?.commitments ?? []
        checks.push(check('export --all 账本中出现人工确认的承诺', commitmentRows.some((row) => row.action === action && row.status === 'open'), commitmentRows.map((row) => row.action).join(' | ')))
      }
      return checks
    },
  }
}

// ---------------------------------------------------------------------------
// 5 个 persona 的合成画像与 15 个任务。
// ---------------------------------------------------------------------------

const PERSONA_META = [
  {
    id: 1,
    name: '林知远',
    role: '独立咨询顾问',
    slug: 'consultant',
    clients: ['云启制造', '蓝湾资本', '禾木零售'],
    preferences: ['周报先给结论，再给三个数据点。'],
    delivers: ['Q4 诊断报告', '客户周报', '报价单'],
    marker: '蓝湾资本',
    deliverableFile: '',
    note: '合成画像（化名）：同时服务 3 家客户，交付以诊断报告/周报/报价单为主，习惯周五给客户结论。',
  },
  {
    id: 2,
    name: '沈栖迟',
    role: '自由设计师',
    slug: 'designer',
    clients: ['木白咖啡', '山海文旅', '原点设计'],
    preferences: ['视觉稿先给两个方向，再给推荐。'],
    delivers: ['品牌提案', 'Logo 三稿', '设计报价单'],
    marker: '木白咖啡',
    deliverableFile: 'out/mubai-brand-proposal.docx',
    note: '合成画像（化名）：自由设计师，客户以餐饮/文旅为主，交付品牌提案与视觉稿。',
  },
  {
    id: 3,
    name: '周时雨',
    role: '小团队负责人',
    slug: 'team-lead',
    clients: ['清源环保', '智造云', '恒信审计'],
    preferences: ['任务先定负责人和截止日。'],
    delivers: ['交付排期表', '周会材料', '项目预算'],
    marker: '智造云',
    deliverableFile: 'out/qingyuan-delivery-plan.pptx',
    note: '合成画像（化名）：带 4 人小团队，同时推进 3 个客户项目，交付排期与周会材料。',
  },
  {
    id: 4,
    name: '陆停云',
    role: '技术顾问',
    slug: 'tech-consultant',
    clients: ['星链数据', '云帆科技', '开源社区'],
    preferences: ['方案先写风险与回滚，再写步骤。'],
    delivers: ['迁移方案', '故障复盘', '架构评审'],
    marker: '星链数据',
    deliverableFile: 'out/xinglian-migration-plan.docx',
    note: '合成画像（化名）：独立技术顾问，客户以数据平台迁移、故障复盘为主。',
  },
  {
    id: 5,
    name: '顾青禾',
    role: '独立律师助理',
    slug: 'legal-assistant',
    clients: ['张先生', '何女士', '澄明创业'],
    preferences: ['法律文书先列事实时间线，再列条款。'],
    delivers: ['证据时间线', '合同摘要', '律师函草稿'],
    marker: '张先生',
    deliverableFile: '',
    note: '合成画像（化名）：独立律师助理，为 3 位客户整理证据、合同摘要与时间线。',
  },
]

function buildTasks(persona) {
  switch (persona.id) {
    case 1: {
      const [first, second] = persona.clients
      return [
        makeCommitTask(persona, {
          id: 'p1-t1',
          title: '两条承诺入账 + 显式偏好（同一 home）',
          commitments: [
            { action: `给${first}发 Q4 诊断报告初稿`, quote: '周五前把云启的诊断报告初稿发我，我要先看结论。', due: DUE.soon, creditor: first },
            { action: `约${second}下周电话会`, quote: '下周找时间和蓝湾资本过一遍电话会。', due: DUE.later, creditor: second },
          ],
          preference: persona.preferences[0],
        }),
        makeContinuityTask(persona, {
          id: 'p1-t2',
          title: '跨会话：新进程 today/tick 看到 T1 承诺，再带证据标记完成',
          firstAction: `给${first}发 Q4 诊断报告初稿`,
          secondAction: `约${second}下周电话会`,
          mutate: 'done',
        }),
        makeCaptureTask(persona, {
          id: 'p1-t3',
          title: 'capture 候选承诺：pending 不入账，人工 accept 后才可见',
          preference: persona.preferences[0],
          text: '云启制造的王工今天来电话。我答应他周五前把 14 万报价单发过去。蓝湾资本的材料，我也答应下周一前发过去。',
          source: 'meeting',
        }),
      ]
    }
    case 2: {
      const [first, second] = persona.clients
      return [
        makeCommitTask(persona, {
          id: 'p2-t1',
          title: '两条承诺入账 + 显式偏好（同一 home）',
          commitments: [
            { action: `给${first}交品牌提案第一版`, quote: '木白那边想先看品牌提案第一版。', due: DUE.soon, creditor: first },
            { action: `给${second}交 Logo 三稿`, quote: '山海文旅要三个方向的 Logo 稿。', due: DUE.later, creditor: second },
          ],
          preference: persona.preferences[0],
        }),
        makeOfficeTask(persona, {
          id: 'p2-t2',
          title: 'office 生成品牌提案 docx + verify --content + 交付回执',
          kind: 'docx',
          specPath: 'specs/mubai-brand-proposal.json',
          outPath: 'out/mubai-brand-proposal.docx',
          minEntries: 10,
          tokens: ['木白咖啡', '品牌提案', '门头', '菜单'],
          spec: {
            title: '木白咖啡品牌提案',
            subtitle: '客户：木白咖啡 · 第一版 · 合成示例',
            sections: [
              { heading: '结论', paragraphs: ['建议先做门头与菜单两个方向，再延展到外卖包装。'] },
              { heading: '方向一：门店视觉', bullets: ['门头保留原木色，新增暖光字牌。', '菜单用单页双面，突出季节限定。'] },
              { heading: '报价', table: { headers: ['项目', '金额'], rows: [['门头', '3.2 万'], ['菜单', '1.1 万']] } },
            ],
          },
        }),
        makeReviewTask(persona, {
          id: 'p2-t3',
          title: 'review 只读审阅品牌提案：文件不变、输出与退出码自洽',
          fileRel: 'out/mubai-brand-proposal.docx',
          request: '检查这份品牌提案：是否有占位符、客户名不一致或金额前后矛盾；只审阅，不要改文件。',
        }),
      ]
    }
    case 3: {
      const [first, second] = persona.clients
      return [
        makeCommitTask(persona, {
          id: 'p3-t1',
          title: '两条承诺入账 + 显式偏好（同一 home）',
          commitments: [
            { action: `给${first}发交付排期表`, quote: '清源环保周五要看到排期表。', due: DUE.soon, creditor: first },
            { action: `和${second}确认周会时间`, quote: '下周四和智造云把周会时间定下来。', due: DUE.far, creditor: second },
          ],
          preference: persona.preferences[0],
        }),
        makeContinuityTask(persona, {
          id: 'p3-t2',
          title: '跨会话：today/tick 看到 T1 承诺；snooze 后 tick/today 同步隐藏',
          firstAction: `给${first}发交付排期表`,
          secondAction: `和${second}确认周会时间`,
          mutate: 'snooze',
        }),
        makeOfficeTask(persona, {
          id: 'p3-t3',
          title: 'office 生成周会 deck + verify + 幻灯片页数',
          kind: 'pptx',
          specPath: 'specs/qingyuan-delivery-plan.json',
          outPath: 'out/qingyuan-delivery-plan.pptx',
          minEntries: 20,
          slideCount: 3,
          tokens: ['清源环保', '交付排期', '风险'],
          spec: {
            title: '清源环保交付排期',
            subtitle: '周会材料 · 合成示例',
            slides: [
              { title: '本周进展', bullets: ['交付排期表完成', '审计资料已收齐'] },
              { title: '风险与阻塞', bullets: ['外包交付延期 2 天'] },
              { title: '下一步', bullets: ['周三前确认排期', '把风险同步给客户'] },
            ],
          },
        }),
      ]
    }
    case 4: {
      const [first, second] = persona.clients
      return [
        makeCommitTask(persona, {
          id: 'p4-t1',
          title: '两条承诺入账 + 显式偏好（同一 home）',
          commitments: [
            { action: `给${first}写迁移方案初稿`, quote: '星链数据下周要看迁移方案初稿。', due: DUE.soon, creditor: first },
            { action: `给${second}出故障复盘`, quote: '云帆那边要一份故障复盘。', due: DUE.later, creditor: second },
          ],
          preference: persona.preferences[0],
        }),
        makeOfficeTask(persona, {
          id: 'p4-t2',
          title: 'office 生成迁移方案 docx + verify --content + 交付回执',
          kind: 'docx',
          specPath: 'specs/xinglian-migration-plan.json',
          outPath: 'out/xinglian-migration-plan.docx',
          minEntries: 10,
          tokens: ['星链数据', '迁移方案', '回滚', '双写'],
          spec: {
            title: '星链数据迁移方案（初稿）',
            subtitle: '技术顾问：陆停云 · 合成示例',
            sections: [
              { heading: '范围', paragraphs: ['把订单库从自建 MySQL 迁到托管 PostgreSQL，分两批切换。'] },
              { heading: '风险与回滚', bullets: ['双写期间主键冲突需要去重脚本。', '回滚窗口 30 分钟，保留旧库只读。'] },
              { heading: '步骤', bullets: ['第 1 周：影子库与双写', '第 2 周：灰度读切换', '第 3 周：写切换与回滚演练'] },
            ],
          },
        }),
        makeReviewTask(persona, {
          id: 'p4-t3',
          title: 'review 只读审阅迁移方案：文件不变、输出与退出码自洽',
          fileRel: 'out/xinglian-migration-plan.docx',
          request: '检查这份迁移方案：是否有占位符、风险与回滚步骤缺失或前后矛盾；只审阅，不要改文件。',
        }),
      ]
    }
    case 5: {
      const [first, second] = persona.clients
      return [
        makeCommitTask(persona, {
          id: 'p5-t1',
          title: '两条承诺入账 + 显式偏好（其中一条已逾期）',
          commitments: [
            { action: `给${first}整理证据时间线`, quote: '张先生说这周内要看到证据时间线。', due: DUE.overdue, creditor: first },
            { action: `给${second}发合同摘要`, quote: '何女士下周二前要合同摘要。', due: DUE.later, creditor: second },
          ],
          preference: persona.preferences[0],
        }),
        makeContinuityTask(persona, {
          id: 'p5-t2',
          title: '跨会话：新进程 today/tick 看到逾期与近期承诺',
          firstAction: `给${first}整理证据时间线`,
          secondAction: `给${second}发合同摘要`,
          mutate: 'none',
          expectOverdue: true,
        }),
        makeCaptureTask(persona, {
          id: 'p5-t3',
          title: 'capture 法律事项候选：pending 不入账，人工 accept 后 today 可见',
          preference: persona.preferences[0],
          text: '张先生今天来电话。我答应他周五前把证据时间线发过去；何女士要合同摘要，我也答应下周二前发她。',
          source: 'meeting',
        }),
      ]
    }
    default:
      throw new Error(`unknown persona id: ${persona.id}`)
  }
}

const PERSONAS = PERSONA_META.map((meta) => {
  const tasks = buildTasks(meta)
  // 同一 persona 的 3 个任务是有顺序的“连续使用”，依赖前一个任务；执行器
  // 仍然会跑完全部任务（失败也继续收集信号），dependsOn 只用于计划/报告。
  for (let index = 1; index < tasks.length; index += 1) tasks[index].dependsOn = [tasks[index - 1].id]
  return { ...meta, tasks }
})

function selectedPersonas(raw = process.env.PERSONAS) {
  const all = PERSONAS.map((persona) => persona.id)
  const text = String(raw ?? '').trim()
  if (!text) return PERSONAS
  const wanted = [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean).map(Number))]
  const bad = wanted.filter((id) => !Number.isInteger(id) || !all.includes(id))
  if (bad.length) throw new Error(`unknown PERSONAS: ${bad.join(',')} (valid: ${all.join(',')})`)
  if (!wanted.length) return PERSONAS
  return PERSONAS.filter((persona) => wanted.includes(persona.id))
}

// ---------------------------------------------------------------------------
// CLI 执行层
// ---------------------------------------------------------------------------

function buildChildEnv(home, key) {
  const env = {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_FORCE: '1',
  }
  // 真实模式必须让 CLI 走模型；ADVISERS_NO_MODEL=1 只用于验证“需要真实 key”的
  // 快速失败路径，不能泄漏进真实子进程。
  delete env.ADVISERS_NO_MODEL
  if (!env.ADVISERS_MODEL) env.ADVISERS_MODEL = 'deepseek-flash'
  if (key) env.ADVISERS_API_KEY = key
  return env
}

function runCli(persona, argv) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [CLI_PATH, ...argv], {
    cwd: persona.work,
    env: persona.childEnv,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
  })
  const timedOut = result.error?.code === 'ETIMEDOUT' || Boolean(result.error && /timed?\s*out/i.test(String(result.error.message || '')))
  return {
    argv,
    exitCode: result.status,
    timedOut,
    error: result.error ? String(result.error.message || result.error) : '',
    durationMs: Date.now() - startedAt,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function exitDetail(run) {
  if (run.timedOut) return `timeout after ${CLI_TIMEOUT_MS}ms`
  if (run.error) return `spawn error: ${run.error}`
  if (run.exitCode !== 0) return `exit ${run.exitCode}${run.stderr ? ` / ${summarize(run.stderr, 180)}` : ''}`
  return `exit ${run.exitCode}`
}

function serializedCommand(step, run) {
  return {
    label: step.label,
    command: formatCommand(run.argv),
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    stdoutSummary: summarize(run.stdout, 360),
    ...(run.exitCode !== 0 && run.stderr ? { stderrSummary: summarize(run.stderr, 240) } : {}),
  }
}

/**
 * 执行单个任务（真正 async：会 await 任务断言）。
 * 返回的结果对象即写入 results 的条目。
 */
async function executeTask(ctx, task) {
  const persona = ctx.personas.get(task.personaId)
  const startedAt = Date.now()
  const stepRuns = []
  const state = {}
  const checks = []

  for (const fixture of task.fixtures ?? []) {
    const abs = join(persona.work, fixture.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, fixture.content)
  }

  let aborted = false
  for (const step of task.steps) {
    let argv
    try {
      argv = typeof step.argv === 'function' ? step.argv(state) : step.argv
    } catch (error) {
      checks.push(check(`${step.label} 命令可构造`, false, String(error?.message || error).slice(0, 240)))
      aborted = true
      break
    }
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
      checks.push(check(`${step.label} 命令可构造`, false, `invalid argv: ${JSON.stringify(argv)}`))
      aborted = true
      break
    }
    const run = runCli(persona, argv)
    stepRuns.push({ label: step.label, argv, ...run, step })
    const expected = step.expectExit ?? [0]
    const ok = !run.timedOut && !run.error && run.exitCode !== null && expected.includes(run.exitCode)
    checks.push(check(`${step.label}（${formatCommand(argv)}）`, ok, ok ? `exit ${run.exitCode} / ${run.durationMs}ms` : exitDetail(run)))
    if (step.collect) {
      const match = String(run.stdout ?? '').match(step.collect.re)
      if (match) state[step.collect.name] = match[1]
      else checks.push(check(`${step.label} 提取 ${step.collect.name}`, false, summarize(run.stdout, 240)))
    }
    if (!ok) {
      aborted = true
      break
    }
  }

  if (aborted) {
    checks.push(check('后续断言因前序命令失败未执行', false, 'aborted'))
  } else if (task.assert) {
    try {
      checks.push(...((await task.assert(ctx, { stepRuns, state, persona })) ?? []))
    } catch (error) {
      checks.push(check('任务断言未抛异常', false, String(error?.message || error).slice(0, 300)))
    }
  }

  const failedChecks = checks.filter((entry) => !entry.ok)
  const result = {
    id: task.id,
    persona: { id: persona.id, name: persona.name, role: persona.role },
    task: task.title,
    kind: task.kind,
    dependsOn: task.dependsOn ?? [],
    status: checks.length > 0 && failedChecks.length === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - startedAt,
    commands: stepRuns.map((run) => serializedCommand(run.step, run)),
    checks,
  }
  if (aborted) result.aborted = true
  console.error(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${task.id} (${result.durationMs}ms)`)
  for (const entry of failedChecks) console.error(`  - ${entry.name}: ${entry.detail}`)
  return result
}

// ---------------------------------------------------------------------------
// 跨 persona / home 隔离检查（不属于 15 个任务，单独汇总到 globalChecks）
// ---------------------------------------------------------------------------

function runIsolationChecks(personas) {
  const checks = []
  checks.push(check('5 个 persona 使用互不相同的 home', new Set(personas.map((persona) => persona.home)).size === personas.length, personas.map((persona) => `P${persona.id}`).join(',')))

  for (const persona of personas) {
    const tag = `P${persona.id} ${persona.name}`
    const today = runCli(persona, ['today'])
    const prefs = runCli(persona, ['prefs'])
    const exported = runCli(persona, ['export'])
    const deliveries = runCli(persona, ['deliveries'])
    const foreign = personas.filter((other) => other.id !== persona.id)

    for (const [label, run] of [
      ['today', today],
      ['prefs', prefs],
      ['export', exported],
      ['deliveries', deliveries],
    ]) {
      checks.push(check(`${tag} 隔离检查：${label} 进程正常`, !run.timedOut && !run.error && run.exitCode === 0, exitDetail(run)))
    }

    const foreignMarkers = foreign.map((other) => other.marker)
    const leakedToday = foreignMarkers.filter((marker) => today.stdout.includes(marker))
    checks.push(check(`${tag} today 能看到本 home 客户「${persona.marker}」`, today.stdout.includes(persona.marker), summarize(today.stdout)))
    checks.push(check(`${tag} today 没有其他 persona 的客户痕迹`, leakedToday.length === 0, leakedToday.length ? `leaked: ${leakedToday.join(',')}` : 'none'))

    const ownPref = persona.preferences[0]
    const prefLines = lines(prefs.stdout)
    const leakedPrefs = foreign.map((other) => other.preferences[0]).filter((statement) => prefs.stdout.includes(statement))
    checks.push(check(`${tag} prefs 只包含本 home 的显式偏好`, prefLines.length === 1 && prefLines[0].includes(ownPref), summarize(prefs.stdout)))
    checks.push(check(`${tag} prefs 没有其他 persona 的偏好`, leakedPrefs.length === 0, leakedPrefs.length ? `leaked: ${leakedPrefs.join(',')}` : 'none'))

    const ledger = parseJson(exported.stdout)
    checks.push(check(`${tag} export 可解析`, Boolean(ledger), summarize(exported.stdout)))
    checks.push(check(`${tag} export 能看到本 home 的客户痕迹`, exported.stdout.includes(persona.marker), 'marker missing'))
    checks.push(check(`${tag} export 没有其他 persona 的客户痕迹`, foreignMarkers.every((marker) => !exported.stdout.includes(marker)), foreignMarkers.filter((marker) => exported.stdout.includes(marker)).join(',') || 'none'))
    if (ledger) checks.push(check(`${tag} export 中 matter 唯一`, (ledger.matters ?? []).length === 1, `${(ledger.matters ?? []).length} matter(s)`))

    const ownFile = persona.deliverableFile ? basename(persona.deliverableFile) : ''
    const foreignFiles = foreign.map((other) => (other.deliverableFile ? basename(other.deliverableFile) : '')).filter(Boolean)
    if (ownFile) {
      checks.push(check(`${tag} deliveries 含本 home 交付物「${ownFile}」`, deliveries.stdout.includes(ownFile), summarize(deliveries.stdout)))
    }
    const leakedFiles = foreignFiles.filter((file) => deliveries.stdout.includes(file))
    checks.push(check(`${tag} deliveries 没有其他 persona 交付物`, leakedFiles.length === 0, leakedFiles.length ? `leaked: ${leakedFiles.join(',')}` : 'none'))

    checks.push(check(`${tag} 独立 home 中存在 SQLite state.db`, existsSync(join(persona.home, 'state.db')), 'state.db'))
  }
  return checks
}

// ---------------------------------------------------------------------------
// DRY_RUN 与汇总
// ---------------------------------------------------------------------------

function coverageOf(personas) {
  const coverage = { commitments: 0, 'cross-session': 0, office: 0, review: 0, capture: 0 }
  for (const persona of personas) for (const task of persona.tasks) coverage[task.kind] = (coverage[task.kind] ?? 0) + 1
  return coverage
}

function dryPlan(persona, task) {
  return {
    id: task.id,
    persona: { id: persona.id, name: persona.name, role: persona.role },
    task: task.title,
    kind: task.kind,
    dependsOn: task.dependsOn ?? [],
    home: `persona-${persona.id}/home`,
    work: `persona-${persona.id}/work`,
    fixtures: (task.fixtures ?? []).map((fixture) => fixture.path),
    commands: task.steps.map((step) => ({ label: step.label, command: dryCommand(step) })),
    assertions: task.assertions,
    status: 'dry-run',
  }
}

function personaSummary(persona) {
  return {
    id: persona.id,
    name: persona.name,
    role: persona.role,
    note: persona.note,
    clients: persona.clients,
    preferences: persona.preferences,
    delivers: persona.delivers,
    home: `persona-${persona.id}/home`,
    work: `persona-${persona.id}/work`,
    tasks: persona.tasks.map((task) => task.id),
  }
}

function printDryRun(personas) {
  const tasks = personas.flatMap((persona) => persona.tasks)
  console.error(`[dogfood] DRY_RUN=1：${personas.length} personas / ${tasks.length} tasks；不执行 CLI、不读 key、不建临时目录。`)
  const coverage = coverageOf(personas)
  console.error(`[dogfood] 覆盖：${Object.entries(coverage).map(([kind, count]) => `${kind}=${count}`).join(' / ')}`)
  for (const persona of personas) {
    console.error(`\nP${persona.id} ${persona.name}（${persona.role}） clients=${persona.clients.join('/')} home=persona-${persona.id}/home work=persona-${persona.id}/work`)
    for (const task of persona.tasks) {
      console.error(`  ${task.id} [${task.kind}] ${task.title}${task.dependsOn?.length ? `（依赖 ${task.dependsOn.join(',')}）` : ''}`)
      for (const step of task.steps) console.error(`      $ ${dryCommand(step)}`)
    }
  }
  console.error(`\n[dogfood] dry-run 共 ${tasks.length} 个任务；真实运行需要 ADVISERS_API_KEY。`)
}

function buildDryRunSummary(personas) {
  const plans = personas.flatMap((persona) => persona.tasks.map((task) => dryPlan(persona, task)))
  return {
    mode: 'dry-run',
    executed: false,
    cliTimeoutMs: CLI_TIMEOUT_MS,
    model: process.env.ADVISERS_MODEL || 'deepseek-flash',
    selection: { personas: personas.map((persona) => persona.id) },
    personas: personas.length,
    tasks: plans.length,
    passed: 0,
    failed: 0,
    coverage: coverageOf(personas),
    personaList: personas.map(personaSummary),
    results: plans,
    issues: [],
    globalChecks: [],
    note: 'DRY_RUN=1：以上是计划与命令，未执行任何 CLI / 模型调用。真实模式需要真实 key。',
  }
}

function issueList(results, globalChecks) {
  const issues = []
  for (const result of results) {
    for (const entry of result.checks.filter((item) => !item.ok)) {
      issues.push({
        scope: 'task',
        personaId: result.persona.id,
        taskId: result.id,
        task: result.task,
        check: entry.name,
        detail: entry.detail,
      })
    }
  }
  for (const entry of globalChecks.filter((item) => !item.ok)) {
    issues.push({ scope: 'isolation', check: entry.name, detail: entry.detail })
  }
  return issues
}

function realSummary({ personas, results, globalChecks, elapsedMs }) {
  const passed = results.filter((result) => result.status === 'passed').length
  const failed = results.length - passed
  const failedGlobal = globalChecks.filter((entry) => !entry.ok).length
  return {
    mode: 'real',
    executed: true,
    cliTimeoutMs: CLI_TIMEOUT_MS,
    model: process.env.ADVISERS_MODEL || 'deepseek-flash',
    keyConfigured: true,
    elapsedMs,
    selection: { personas: personas.map((persona) => persona.id) },
    personas: personas.length,
    tasks: results.length,
    passed,
    failed,
    coverage: coverageOf(personas),
    personaList: personas.map(personaSummary),
    results,
    globalChecks,
    globalFailed: failedGlobal,
    issues: issueList(results, globalChecks),
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function keyFromEnv() {
  return process.env.ADVISERS_API_KEY || process.env.DEEPSEEK_API_KEY || ''
}

function failFast(message) {
  console.error(`[dogfood] ${message}`)
  process.exitCode = 1
}

export async function main() {
  const dryRun = process.env.DRY_RUN === '1'

  if (dryRun) {
    let personas
    try {
      personas = selectedPersonas()
    } catch (error) {
      failFast(String(error?.message || error))
      return
    }
    printDryRun(personas)
    console.log(JSON.stringify(buildDryRunSummary(personas), null, 2))
    return
  }

  // 真实模式的快速失败：不建临时目录、不 spawn CLI、不打印 key。
  if (process.env.ADVISERS_NO_MODEL === '1') {
    failFast('需要真实 key：ADVISERS_NO_MODEL=1 已禁用模型；本 dogfood 的真实模式必须调用真实模型。离线检查请用 DRY_RUN=1。')
    return
  }
  const key = keyFromEnv()
  if (!key) {
    failFast('需要真实 key：请设置 ADVISERS_API_KEY（或 DEEPSEEK_API_KEY）；只做离线检查请用 DRY_RUN=1。')
    return
  }

  let selected
  try {
    selected = selectedPersonas()
  } catch (error) {
    failFast(String(error?.message || error))
    return
  }

  const startedAt = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'advisers-dogfood-5-'))
  const runtimePersonas = []
  try {
    for (const persona of selected) {
      const base = join(root, `persona-${persona.id}`)
      const home = join(base, 'home')
      const work = join(base, 'work')
      mkdirSync(home, { recursive: true, mode: 0o700 })
      mkdirSync(work, { recursive: true })
      runtimePersonas.push({ ...persona, home, work, childEnv: buildChildEnv(home, key) })
    }
    const ctx = {
      root,
      personas: new Map(runtimePersonas.map((persona) => [persona.id, persona])),
      personaWork: (personaId) => ctx.personas.get(personaId).work,
    }

    const totalTasks = runtimePersonas.reduce((sum, persona) => sum + persona.tasks.length, 0)
    console.error(`[dogfood] 真实模式：${runtimePersonas.length} personas / ${totalTasks} tasks；key 已配置（不打印）；临时目录 ${root}`)
    console.error(`[dogfood] 每个 CLI 调用是新进程（跨会话），超时 ${CLI_TIMEOUT_MS}ms`)

    const results = []
    let index = 0
    for (const persona of runtimePersonas) {
      console.error(`\nP${persona.id} ${persona.name}（${persona.role}） home=${join('persona-' + persona.id, 'home')}`)
      for (const task of persona.tasks) {
        index += 1
        console.error(`[${index}/${totalTasks}] ${task.id} ${task.title}`)
        results.push(await executeTask(ctx, task))
      }
    }

    console.error('\n[dogfood] 跨 persona / home 隔离检查…')
    const globalChecks = runIsolationChecks(runtimePersonas)
    for (const entry of globalChecks.filter((item) => !item.ok)) console.error(`  - isolate: ${entry.name}: ${entry.detail}`)

    const summary = realSummary({ personas: runtimePersonas, results, globalChecks, elapsedMs: Date.now() - startedAt })
    console.log(JSON.stringify(summary, null, 2))
    console.error(`[dogfood] tasks: ${summary.passed} passed / ${summary.failed} failed；global checks: ${globalChecks.length - summary.globalFailed} passed / ${summary.globalFailed} failed`)
    if (summary.failed > 0 || summary.globalFailed > 0) process.exitCode = 1
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(`[dogfood][fatal] ${error?.stack || error?.message || error}`)
    process.exitCode = 1
  }
}
