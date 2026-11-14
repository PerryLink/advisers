#!/usr/bin/env node
/**
 * Real-model continuity probe.
 *
 * Usage: ADVISERS_API_KEY=... [FACTS=10|50|100|200] node eval/run-continuity.mjs
 *
 * The script generates a deterministic, duplicate-free fact set, writes every
 * fact through `advisers chat "<fact>"` into a throw-away ADVISERS_HOME, then
 * asks 8-12 generated probes and reports pass/fail.
 *
 * Requires a real model key (ADVISERS_API_KEY or DEEPSEEK_API_KEY). This eval
 * is NOT run in CI: without a key it exits 1 immediately. stdout carries one
 * JSON document; progress goes to stderr. The temp home/work tree is always
 * removed in a finally block. No key material is written to stdout.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLI_TIMEOUT_MS = 180_000
const FACTS_ALLOWED = [10, 50, 100, 200]

const pad2 = (n) => String(n).padStart(2, '0')
const clientKey = (index) => (index < 26 ? String.fromCharCode(65 + index) : `K${index + 1}`)

// Fixed pools: deterministic, duplicate-free, and long enough for FACTS=200
// (20 facts per category). Names are synthetic; no real customer data.
const PEOPLE = ['阿哲', '博文', '晨曦', '德华', '恩泽', '芳菲', '国安', '海燕', '嘉禾', '静怡', '凯旋', '兰亭', '明轩', '宁远', '佩琪', '清扬', '若水', '思远', '天佑', '婉如']
const CLIENTS = ['华兴科技', '远航集团', '云图数据', '中科实业', '恒信资本', '嘉合地产', '明德教育', '启元医疗', '瑞达物流', '天工机械', '万邦零售', '新程能源', '一格传媒', '泽润环保', '安泰保险', '聚力制造', '众诚食品', '卓远建筑', '弘毅投资', '思源软件']
const COMPANIES = ['星河咨询', '北辰智造', '南风文化', '东篱设计', '西湖数科', '北岸咨询', '青松资本', '白鹭传媒', '赤兔科技', '长河制造', '山南数据', '海西能源', '风起软件', '云栖物流', '星野教育', '月泉医疗', '林间环保', '石桥建筑', '天目零售', '江南食品']
const PARTNERS = ['王工', '李经理', '张老师', '钱主管', '孙工', '周律师', '吴经理', '郑老师', '冯主管', '陈工', '褚经理', '卫老师', '蒋主管', '沈工', '韩经理', '杨老师', '朱主管', '秦工', '许经理', '何老师']
const OWNERS = ['李总', '赵总', '钱总', '孙总', '周总', '吴总', '郑总', '冯总', '陈总', '褚总', '卫总', '蒋总', '沈总', '韩总', '杨总', '朱总', '秦总', '许总', '何总', '吕总']
const COMMITMENT_ACTIONS = ['发报价', '交样品', '订会议室', '发合同', '出方案', '回邮件', '排期评审', '补数据', '约客户', '交发票', '发周报', '定预算', '写纪要', '做复盘', '发邀请', '改条款', '核库存', '催回款', '出报告', '对账单']
const PREFERENCES = [
  { statement: '周报先给结论，再给数据。', token: '先给结论' },
  { statement: '汇报时先讲风险，再讲进展。', token: '先讲风险' },
  { statement: '数据一律保留两位小数。', token: '两位小数' },
  { statement: '会议记录当天发出。', token: '当天发出' },
  { statement: '方案默认给三个选项。', token: '三个选项' },
  { statement: '文档超过两页必须加目录。', token: '必须加目录' },
  { statement: '对外材料先发 PDF 版。', token: '先发 PDF' },
  { statement: '周报固定周五下午提交。', token: '周五下午提交' },
  { statement: '重要结论用加粗标注。', token: '加粗标注' },
  { statement: '需求变更必须留书面记录。', token: '书面记录' },
  { statement: '汇报控制在一页纸内。', token: '一页纸' },
  { statement: '客户反馈当天归档。', token: '当天归档' },
  { statement: '预算类内容单独列附表。', token: '单独列附表' },
  { statement: '引用数据必须附来源。', token: '附来源' },
  { statement: '跨部门协作先拉群对齐。', token: '拉群对齐' },
  { statement: '邮件结论放在正文开头。', token: '正文开头' },
  { statement: '项目风险每周更新一次。', token: '每周更新一次' },
  { statement: '演示材料控制在十页内。', token: '十页内' },
  { statement: '合同条款先经法务确认。', token: '法务确认' },
  { statement: '复盘结论必须可执行。', token: '必须可执行' },
]
const EMAIL_ITEMS = [
  { statement: '不要用“尊敬的”开头', token: '尊敬的' },
  { statement: '邮件抄送直属上级。', token: '抄送直属上级' },
  { statement: '主题必须写客户名和事项。', token: '主题必须写' },
  { statement: '正文不超过三段。', token: '不超过三段' },
  { statement: '附件统一命名 客户_日期。', token: '附件统一命名' },
  { statement: '重要邮件要求已读回执。', token: '已读回执' },
  { statement: '回复邮件保留原文引用。', token: '保留原文引用' },
  { statement: '邮件结尾附上联系方式。', token: '附上联系方式' },
  { statement: '同一事项只发一封邮件。', token: '只发一封' },
  { statement: '邮件不用表情符号。', token: '表情符号' },
  { statement: '紧急事项在主题加【紧急】。', token: '【紧急】' },
  { statement: '收件人超过五人用密送。', token: '用密送' },
  { statement: '邮件正文首句写明来意。', token: '首句写明来意' },
  { statement: '外发邮件必须抄送项目经理。', token: '抄送项目经理' },
  { statement: '邮件附件不超过 5 MB。', token: '不超过 5 MB' },
  { statement: '邮件签名固定使用公司模板。', token: '公司模板' },
  { statement: '邮件引用金额保留单位。', token: '保留单位' },
  { statement: '邮件正式场合不加问号结尾。', token: '不加问号结尾' },
  { statement: '邮件跟进超过三天需升级。', token: '超过三天需升级' },
  { statement: '邮件落款必须写全名。', token: '落款必须写全名' },
]

// 2026 dates, 72 unique values, deterministic order. Project dates and
// deadlines draw from disjoint slices so every date token is unique.
const DATE_POOL = (() => {
  const out = []
  for (let m = 1; m <= 12; m++) for (const d of [3, 8, 13, 18, 23, 28]) out.push(`2026-${pad2(m)}-${pad2(d)}`)
  return out
})()
const PROJECT_DATES = DATE_POOL.slice(0, 20)
const DEADLINE_DATES = DATE_POOL.slice(20, 40)

function dateProbe(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return {
    expect: iso,
    accept: [iso, `${year}年${month}月${day}日`, `${month}月${day}日`, `${month}月${day}号`],
  }
}

// Every generator returns a fact plus the question that probes it. Answers are
// judged against `accept` after whitespace removal, so "300 万" / "300万" and
// ISO / Chinese date renderings both match.
const FACT_GENERATORS = {
  person(i) {
    const name = PEOPLE[i]
    if (i === 0) return { text: `我叫${name}，时区是 Asia/Shanghai。`, question: '我叫什么名字？', expect: name, accept: [name] }
    return { text: `我的同事第${i}号叫${name}。`, question: `我的同事第${i}号叫什么？`, expect: name, accept: [name] }
  },
  clientName(i) {
    const key = clientKey(i)
    const name = CLIENTS[i]
    return { text: `客户 ${key} 的名称是${name}。`, question: `客户 ${key} 的名称是什么？`, expect: name, accept: [name] }
  },
  budget(i) {
    const key = clientKey(i + 1)
    const amount = 300 + i * 17
    return { text: `客户 ${key} 的预算底线是 ${amount} 万元。`, question: `客户 ${key} 的预算底线是多少？`, expect: String(amount), accept: [String(amount)] }
  },
  projectDate(i) {
    const key = clientKey(i + 4)
    const iso = PROJECT_DATES[i]
    return { text: `客户 ${key} 的项目启动日期是 ${iso}。`, question: `客户 ${key} 的项目启动日期是什么？`, ...dateProbe(iso) }
  },
  preference(i) {
    if (i === 0) return { text: '我的周报偏好是先给结论。', question: '我的周报偏好是什么？', expect: '先给结论', accept: ['先给结论', '结论先行', '结论先给'] }
    const item = PREFERENCES[i]
    return { text: `我的工作偏好（编号 P${i + 1}）是：${item.statement}`, question: `我的工作偏好 P${i + 1} 是什么？`, expect: item.token, accept: [item.token] }
  },
  commitment(i) {
    if (i === 0) return { text: '我答应王工周五前发报价。', question: '我答应了王工什么？', expect: '发报价', accept: ['发报价', '报价'] }
    const partner = PARTNERS[i]
    const weekday = ['一', '二', '三', '四', '五'][i % 5]
    const action = COMMITMENT_ACTIONS[i]
    // Accept the verb-stripped form too: a correct answer may say
    // "向王工发送报价" instead of repeating the exact captured action.
    return { text: `我答应${partner}在周${weekday}前${action}。`, question: `我答应了${partner}什么？`, expect: action, accept: [action, action.replace(/^(发|给|交付|交|回|订|出|排|补|约|定|写|做|改|核|催|对)/, '')].filter(Boolean) }
  },
  owner(i) {
    const key = clientKey(i + 2)
    const owner = OWNERS[i]
    return { text: `客户 ${key} 的项目负责人是${owner}。`, question: `客户 ${key} 的项目负责人是谁？`, expect: owner, accept: [owner] }
  },
  company(i) {
    if (i === 0) return { text: `我的公司叫${COMPANIES[0]}。`, question: '我的公司叫什么？', expect: COMPANIES[0], accept: [COMPANIES[0]] }
    return { text: `我的第${i}家合作公司叫${COMPANIES[i]}。`, question: `我的第${i}家合作公司叫什么？`, expect: COMPANIES[i], accept: [COMPANIES[i]] }
  },
  email(i) {
    if (i === 0) return { text: '写邮件不要用“尊敬的”开头。', question: '我写邮件有什么偏好？', expect: '尊敬的', accept: ['尊敬的'] }
    const item = EMAIL_ITEMS[i]
    return { text: `我的邮件偏好（编号 E${i + 1}）是：${item.statement}`, question: `我的邮件偏好 E${i + 1} 是什么？`, expect: item.token, accept: [item.token] }
  },
  deadline(i) {
    const key = clientKey(i + 3)
    const iso = DEADLINE_DATES[i]
    return { text: `客户 ${key} 的项目截止日期是 ${iso}。`, question: `客户 ${key} 的项目截止日期是什么？`, ...dateProbe(iso) }
  },
}

const CATEGORY_ORDER = ['person', 'clientName', 'budget', 'projectDate', 'preference', 'commitment', 'owner', 'company', 'email', 'deadline']
const BASE_PROBE_CATEGORIES = ['person', 'clientName', 'budget', 'preference', 'commitment', 'owner', 'company', 'deadline']

export function buildFacts(count) {
  const facts = []
  for (let index = 0; index < count; index++) {
    const category = CATEGORY_ORDER[index % CATEGORY_ORDER.length]
    const i = Math.floor(index / CATEGORY_ORDER.length)
    facts.push({ index: index + 1, category, i, ...FACT_GENERATORS[category](i) })
  }
  const texts = new Set(facts.map((fact) => fact.text))
  if (texts.size !== facts.length) throw new Error('fact generator produced duplicate facts')
  return facts
}

function probeTarget(count) {
  if (count === 10) return 8
  if (count === 50) return 9
  if (count === 100) return 10
  return 12
}

export function buildProbes(facts, count) {
  const target = probeTarget(count)
  const byKey = new Map(facts.map((fact) => [`${fact.category}:${fact.i}`, fact]))
  const chosen = []
  const take = (category, i) => {
    const fact = byKey.get(`${category}:${i}`)
    if (fact && !chosen.includes(fact)) chosen.push(fact)
  }
  for (const category of BASE_PROBE_CATEGORIES) take(category, 0)
  for (const [category, i] of [['projectDate', 0], ['email', 0]]) {
    if (chosen.length >= target) break
    take(category, i)
  }
  const rounds = Math.ceil(count / CATEGORY_ORDER.length)
  for (let i = 1; i < rounds && chosen.length < target; i++) {
    for (const category of CATEGORY_ORDER) {
      if (chosen.length >= target) break
      take(category, i)
    }
  }
  if (chosen.length !== target) throw new Error(`expected ${target} probes, generated ${chosen.length}`)
  return chosen.map((fact) => ({ probe: fact.question, expect: fact.expect, accept: fact.accept }))
}

function normalize(text) {
  return String(text).replace(/\s+/g, '')
}

function judge(answer, probe) {
  const text = normalize(answer)
  return probe.accept.some((token) => text.includes(normalize(token)))
}

function runChat(cli, env, cwd, text, timeoutMs = CLI_TIMEOUT_MS) {
  const result = spawnSync(process.execPath, [cli, 'chat', text], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new Error(`chat timed out after ${timeoutMs}ms`)
    throw new Error(String(result.error.message || result.error))
  }
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(`chat exited ${result.status}${result.signal ? ` (${result.signal})` : ''}: ${detail}`)
  }
  return result.stdout || ''
}

export async function main() {
  const key = process.env.ADVISERS_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!key) {
    console.error('ADVISERS_API_KEY (or DEEPSEEK_API_KEY) is required: this eval calls a real model and is not run in CI')
    process.exit(1)
    return
  }
  const factsCount = Number(process.env.FACTS || '10')
  if (!Number.isInteger(factsCount) || !FACTS_ALLOWED.includes(factsCount)) {
    console.error(`FACTS must be one of ${FACTS_ALLOWED.join('|')} (got ${process.env.FACTS})`)
    process.exit(1)
    return
  }

  const facts = buildFacts(factsCount)
  const probes = buildProbes(facts, factsCount)
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../packages/advisers/bin/advisers.js')
  const startedAt = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'advisers-continuity-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const childEnv = {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_API_KEY: key,
    ADVISERS_MODEL: process.env.ADVISERS_MODEL || 'deepseek-flash',
  }
  delete childEnv.ADVISERS_NO_MODEL

  let passed = 0
  let elapsedMs = 0
  const failures = []
  try {
    facts.forEach((fact, index) => {
      try {
        runChat(cli, childEnv, work, fact.text)
        console.error(`[fact ${index + 1}/${facts.length}] ${fact.category}: stored`)
      } catch (error) {
        console.error(`[fact ${index + 1}/${facts.length}] ${fact.category}: failed (${error.message})`)
      }
    })
    probes.forEach((probe, index) => {
      let answer
      try {
        answer = runChat(cli, childEnv, work, probe.probe)
      } catch (error) {
        answer = `[error] ${error.message}`
      }
      const cleaned = String(answer).replace(/\[tool\][^\n]*/g, ' ').replace(/\s+/g, ' ').trim()
      // Judge the whole answer: tool-trace prefixes used to push the actual
      // sentence past the first 300 chars and create false negatives.
      const ok = judge(cleaned, probe)
      const record = cleaned.slice(-600)
      if (ok) passed++
      else failures.push({ probe: probe.probe, expect: probe.expect, answer: record })
      console.error(`[probe ${index + 1}/${probes.length}] ${ok ? 'PASS' : 'FAIL'} ${probe.probe} -> ${record.slice(0, 100)}`)
    })
    elapsedMs = Date.now() - startedAt
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }

  console.log(JSON.stringify({ facts: facts.length, probes: probes.length, passed, failures, elapsedMs }, null, 2))
  if (passed < Math.ceil(probes.length * 0.75)) process.exitCode = 1
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(`[fatal] ${error?.message || error}`)
    process.exitCode = 1
  }
}
