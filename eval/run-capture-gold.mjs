#!/usr/bin/env node
/**
 * eval/run-capture-gold.mjs — 中文承诺金标脚手架的离线校验 + 真实模型指标计算。
 *
 * ⚠️ 状态声明
 * - 默认输入 eval/corpus/gold/commitments.zh.gold.seed.jsonl 是 **AI 预标草稿（seed）**，
 *   每条 pending_human_review: true，**不是人工金标**。
 * - 本脚本的阈值只用于内部回归；运行结果不得写成“已达标”，也不得对外宣称是
 *   人工金标 benchmark 结果。人工双人复核后的文件应另存为
 *   commitments.zh.gold.human.jsonl 再评测。
 * - 真实模型阶段复用 packages/advisers/lib/capture.js 的 captureCandidates；
 *   本脚本不打印、不落盘 API key。
 *
 * 用法：
 *   node eval/run-capture-gold.mjs --dry-run
 *       离线校验 JSONL 是否满足 schema / 字段规范（不需要 API key，不联网）。
 *   DEEPSEEK_API_KEY=... node eval/run-capture-gold.mjs
 *       调用真实模型抽候选，计算 quote 合法率 / firm recall / due 准确率 /
 *       precision / auto-confirmed，逐例输出失败并给出 JSON 汇总。
 *   DEEPSEEK_API_KEY=... node eval/run-capture-gold.mjs --file path.jsonl --limit 20
 *   node eval/run-capture-gold.mjs --dry-run --json /tmp/gold-check.json
 *
 * 失败阈值（真实模型阶段，任一不满足 exit 1）：
 *   quote 合法率 100%、firm recall ≥85%、due 准确率 ≥95%（due/dueAlt 二选一）、
 *   precision ≥75%、auto-confirmed = 0。dry-run 只校验字段，不计算模型指标。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureCandidates } from '../packages/advisers/lib/capture.js'

const DEFAULT_GOLD = fileURLToPath(new URL('./corpus/gold/commitments.zh.gold.seed.jsonl', import.meta.url))
const SCHEMA_PATH = fileURLToPath(new URL('./corpus/gold/commitments.zh.gold.schema.json', import.meta.url))
const SEED_STATUS = 'AI-prelabeled draft seed, NOT human gold; all entries pending_human_review=true'
const TARGETS = {
  quoteValidity: 1,
  firmRecall: 0.85,
  dueAccuracy: 0.95,
  precision: 0.75,
  autoConfirmed: 0,
}

function parseArgs(argv) {
  const opts = { dryRun: false, help: false, file: undefined, limit: undefined, json: undefined, concurrency: undefined }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--file') opts.file = argv[++i]
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length)
    else if (arg === '--limit') opts.limit = Number(argv[++i])
    else if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice('--limit='.length))
    else if (arg === '--json') opts.json = argv[++i]
    else if (arg.startsWith('--json=')) opts.json = arg.slice('--json='.length)
    else if (arg === '--concurrency') opts.concurrency = Number(argv[++i])
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Number(arg.slice('--concurrency='.length))
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    else positional.push(arg)
  }
  if (!opts.file && positional[0]) opts.file = positional[0]
  return opts
}

function help() {
  console.log(`用法: node eval/run-capture-gold.mjs [--dry-run] [--file <jsonl>] [--limit N] [--json <path>]

  --dry-run        只校验 schema/字段（离线，不需要 key）
  --file <jsonl>   指定 gold 文件（默认 eval/corpus/gold/commitments.zh.gold.seed.jsonl）
  --limit N        只评前 N 条
  --json <path>    额外把 JSON 汇总写到指定文件
  --concurrency N  真实模型阶段的并发数（默认 4）

真实模型阶段需要 DEEPSEEK_API_KEY 或 ADVISERS_API_KEY。默认 seed 是 AI 预标草稿，
不是人工金标；阈值只用于内部回归。`)
}

// ---------------------------------------------------------------------------
// 轻量 JSON Schema 校验器：只覆盖本目录 schema 用到的 draft 2020-12 子集。
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'object') return typeOf(value) === 'object'
  if (type === 'array') return Array.isArray(value)
  if (type === 'null') return value === null
  return typeOf(value) === type
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function resolveRef(schema, root) {
  if (!schema || typeof schema !== 'object' || !schema.$ref) return schema
  if (!schema.$ref.startsWith('#/')) throw new Error(`unsupported $ref: ${schema.$ref}`)
  let node = root
  for (const part of schema.$ref.slice(2).split('/')) {
    node = node?.[part]
    if (node === undefined) throw new Error(`unresolvable $ref: ${schema.$ref}`)
  }
  return node
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validateAgainst(value, schema, root, path = '$') {
  const errors = []
  if (!schema || typeof schema !== 'object') return errors
  if (schema.$ref) return validateAgainst(value, resolveRef(schema, root), root, path)
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`)
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`)
      return errors
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`)
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength ${schema.maxLength}`)
    if (schema.pattern) {
      let re
      try { re = new RegExp(schema.pattern) } catch { re = undefined }
      if (!re || !re.test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`)
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path}: invalid date-time ${JSON.stringify(value)}`)
    if (schema.format === 'date' && !validDateOnly(value)) errors.push(`${path}: invalid date ${JSON.stringify(value)}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`)
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than maxItems ${schema.maxItems}`)
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainst(item, schema.items, root, `${path}[${index}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}: missing required property "${key}"`)
    }
    const properties = schema.properties || {}
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) errors.push(...validateAgainst(value[key], subSchema, root, `${path}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}: unexpected property "${key}"`)
      }
    }
  }
  if (schema.if && schema.then) {
    const ifErrors = validateAgainst(value, schema.if, root, path)
    if (!ifErrors.length) errors.push(...validateAgainst(value, schema.then, root, path))
  }
  return errors
}

// ---------------------------------------------------------------------------
// I/O + 字段语义校验
// ---------------------------------------------------------------------------

function loadJsonl(file) {
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  const items = []
  const errors = []
  lines.forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    try { items.push(JSON.parse(text)) } catch (error) {
      errors.push(`line ${index + 1}: invalid JSON (${error.message})`)
    }
  })
  return { items, errors }
}

function semanticCheck(items, { defaultSeed }) {
  const errors = []
  const warnings = []
  const ids = new Set()
  items.forEach((item, index) => {
    const label = item && typeof item === 'object' && item.id ? item.id : `#${index + 1}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label}: item is not an object`); return }
    if (ids.has(item.id)) errors.push(`${label}: duplicate id`)
    ids.add(item.id)
    if (typeof item.text === 'string' && Array.isArray(item.expect)) {
      item.expect.forEach((expect, expectIndex) => {
        if (expect && typeof expect.quote === 'string' && !item.text.includes(expect.quote)) {
          errors.push(`${label}: expect[${expectIndex}] quote is not a verbatim substring of text: ${JSON.stringify(expect.quote)}`)
        }
        for (const key of ['due', 'dueAlt']) {
          if (expect && expect[key] != null && !validDateOnly(expect[key])) errors.push(`${label}: expect[${expectIndex}].${key} is not a valid calendar date: ${JSON.stringify(expect[key])}`)
        }
        if (expect && expect.dueAlt != null && expect.due == null) errors.push(`${label}: expect[${expectIndex}] has dueAlt without due`)
      })
    }
    if (item.pending_human_review !== true && defaultSeed) warnings.push(`${label}: seed 条目应保持 pending_human_review=true（当前 ${JSON.stringify(item.pending_human_review)}）`)
  })
  if (defaultSeed) {
    const reviewed = items.filter((item) => item.pending_human_review !== true).length
    if (reviewed) warnings.push(`seed 共 ${items.length} 条，其中 ${reviewed} 条不是 pending_human_review=true；确认这不是人工复核后的文件`)
  }
  return { errors, warnings }
}

function distribution(items) {
  const out = {
    sources: {},
    modals: { firm: 0, tentative: 0, conditional: 0 },
    expectTotal: 0,
    dueCount: 0,
    dueAltCount: 0,
    nullDueCount: 0,
    negativeItems: 0,
    pendingHumanReview: { true: 0, false: 0 },
    provenance: {},
  }
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    out.sources[item.source] = (out.sources[item.source] || 0) + 1
    out.provenance[item.provenance] = (out.provenance[item.provenance] || 0) + 1
    if (item.pending_human_review === true) out.pendingHumanReview.true++
    else out.pendingHumanReview.false++
    if (!Array.isArray(item.expect) || item.expect.length === 0) out.negativeItems++
    for (const expect of item.expect || []) {
      out.expectTotal++
      if (expect.modal in out.modals) out.modals[expect.modal]++
      if (expect.due == null) out.nullDueCount++
      else out.dueCount++
      if (expect.dueAlt != null) out.dueAltCount++
    }
  }
  return out
}

function validateCorpus(file, { defaultSeed }) {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  const { items, errors: loadErrors } = loadJsonl(file)
  const errors = [...loadErrors]
  items.forEach((item, index) => {
    for (const error of validateAgainst(item, schema, schema)) errors.push(`#${index + 1}: ${error}`)
  })
  if (!items.length) errors.push('corpus is empty')
  const semantic = semanticCheck(items, { defaultSeed })
  errors.push(...semantic.errors)
  const unique = [...new Set(errors)]
  return { schema, items, errors: unique, warnings: semantic.warnings, distribution: distribution(items) }
}

// ---------------------------------------------------------------------------
// 真实模型指标
// ---------------------------------------------------------------------------

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

function actionMatches(candidateAction, expectedAction) {
  const candidate = normalize(candidateAction)
  const expected = normalize(expectedAction)
  if (!candidate || !expected) return false
  if (candidate === expected || candidate.includes(expected) || expected.includes(candidate)) return true
  const strip = (text) => text.replace(/^(把|将|给|向|发送|发给|发|提交|提供|完成|准备|整理|回复|确认|支付|寄|带|补)/, '')
  const left = strip(candidate)
  const right = strip(expected)
  return Boolean(left) && Boolean(right) && (left === right || left.includes(right) || right.includes(left))
}

function quoteMatches(candidateQuote, expectedQuote) {
  const left = normalize(candidateQuote)
  const right = normalize(expectedQuote)
  if (left.length < 4 || right.length < 4) return false
  return left.includes(right) || right.includes(left)
}

function candidateMatches(candidate, expected) {
  return actionMatches(candidate.action, expected.action) || quoteMatches(candidate.quote, expected.quote)
}

function localDueDate(candidate) {
  if (!candidate?.dueAt) return null
  const time = Date.parse(candidate.dueAt)
  if (!Number.isFinite(time)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(time))
}

function evaluateItem(item, candidates) {
  const expectResults = (item.expect || []).map((want) => {
    const matches = candidates.filter((candidate) => candidateMatches(candidate, want))
    return { want, matched: matches.length > 0, matches }
  })
  const matchedExpects = expectResults.filter((row) => row.matched)
  const missing = expectResults.filter((row) => !row.matched).map(({ want }) => ({
    action: want.action,
    quote: want.quote,
    due: want.due ?? null,
    modal: want.modal,
  }))
  const dueMismatches = []
  for (const row of matchedExpects) {
    const acceptable = [row.want.due, row.want.dueAlt].filter(Boolean)
    if (!acceptable.length) continue
    const gotDates = row.matches.map(localDueDate).filter(Boolean)
    if (!gotDates.some((date) => acceptable.includes(date))) {
      dueMismatches.push({ action: row.want.action, expected: row.want.due, dueAlt: row.want.dueAlt ?? null, got: gotDates[0] ?? null })
    }
  }
  const matchedCandidates = candidates.filter((candidate) => (item.expect || []).some((want) => candidateMatches(candidate, want)))
  const quoteValidCandidates = candidates.filter((candidate) => normalize(item.text).includes(normalize(candidate.quote)))
  const modalMismatches = matchedExpects
    .filter((row) => !row.matches.some((candidate) => candidate.modal === row.want.modal))
    .map((row) => ({ action: row.want.action, expected: row.want.modal, got: row.matches[0]?.modal ?? null }))
  return {
    expectResults,
    matchedExpects,
    missing,
    dueMismatches,
    modalMismatches,
    matchedCandidates,
    quoteValidCandidates,
    autoConfirmed: candidates.filter((candidate) => candidate.confirmed === true).length,
    firmExpected: expectResults.filter((row) => row.want.modal === 'firm').length,
    firmMatched: expectResults.filter((row) => row.want.modal === 'firm' && row.matched).length,
    dueChecked: matchedExpects.filter((row) => row.want.due != null || row.want.dueAlt != null).length,
    dueOk: matchedExpects.filter((row) => {
      const acceptable = [row.want.due, row.want.dueAlt].filter(Boolean)
      return acceptable.length > 0 && row.matches.some((candidate) => acceptable.includes(localDueDate(candidate)))
    }).length,
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function percent(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { help(); return }

  const file = resolve(opts.file || DEFAULT_GOLD)
  const defaultSeed = file === resolve(DEFAULT_GOLD)
  const corpus = validateCorpus(file, { defaultSeed })

  const validationSummary = {
    file,
    schema: SCHEMA_PATH,
    total: corpus.items.length,
    schemaValid: corpus.errors.length === 0,
    valid: corpus.errors.length === 0 ? corpus.items.length : null,
    errors: corpus.errors,
    warnings: corpus.warnings,
    pendingHumanReview: corpus.distribution.pendingHumanReview,
    status: defaultSeed ? SEED_STATUS : 'custom corpus (verify human-review status before claiming gold)',
  }
  if (corpus.errors.length) {
    console.error(`[gold] 校验失败：${corpus.errors.length} 个错误`)
    for (const error of corpus.errors.slice(0, 25)) console.error(`  - ${error}`)
    if (corpus.errors.length > 25) console.error(`  ... 其余 ${corpus.errors.length - 25} 个省略`)
  }

  if (opts.dryRun) {
    console.error(`[gold] dry-run：${file}`)
    console.error(`[gold] 状态：${validationSummary.status}`)
    console.error(`[gold] schema/字段校验：${corpus.errors.length ? 'FAIL' : 'PASS'}（${corpus.items.length} 条，${corpus.errors.length} 错误，${corpus.warnings.length} 警告）`)
    console.error(`[gold] 分布：source=${JSON.stringify(corpus.distribution.sources)} expect=${corpus.distribution.expectTotal} modal=${JSON.stringify(corpus.distribution.modals)} negative=${corpus.distribution.negativeItems} pending_human_review=${JSON.stringify(corpus.distribution.pendingHumanReview)}`)
    console.error('[gold] dry-run 不调用真实模型、不计算 recall/precision/due 指标。')
    const summary = {
      mode: 'dry-run',
      timestamp: new Date().toISOString(),
      disclaimer: SEED_STATUS,
      ...validationSummary,
      distributions: corpus.distribution,
      targets: TARGETS,
      metricsMeasured: false,
    }
    console.log(JSON.stringify(summary, null, 2))
    if (opts.json) {
      writeFileSync(resolve(opts.json), `${JSON.stringify(summary, null, 2)}\n`)
      console.error(`[gold] JSON 写到 ${resolve(opts.json)}`)
    }
    if (corpus.errors.length) process.exitCode = 1
    return
  }

  // 真实模型阶段：先确保语料本身合法，再要求 key。
  if (corpus.errors.length) {
    console.error('[gold] 语料校验失败，拒绝进入真实模型阶段。先运行 --dry-run 修复字段错误。')
    process.exitCode = 1
    return
  }
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
  if (!apiKey) {
    console.error('set DEEPSEEK_API_KEY or ADVISERS_API_KEY (or use --dry-run for offline schema validation)')
    process.exitCode = 1
    return
  }

  const total = corpus.items.length
  const limit = opts.limit ?? Number(process.env.LIMIT || total)
  if (!Number.isInteger(limit) || limit < 1 || limit > total) {
    console.error(`[gold] --limit 必须是 1..${total} 的整数（收到 ${opts.limit ?? process.env.LIMIT}）`)
    process.exitCode = 1
    return
  }
  const selected = corpus.items.slice(0, limit)
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency || process.env.CONCURRENCY || 4) || 4, selected.length))
  console.error(`[gold] 真实模型评测 ${selected.length}/${total} 条（source=${JSON.stringify(distribution(selected).sources)}，并发 ${concurrency}）`)
  console.error(`[gold] 状态提醒：${defaultSeed ? SEED_STATUS : validationSummary.status}`)

  const caseResults = await mapLimit(selected, concurrency, async (item) => {
    const started = Date.now()
    try {
      const { candidates } = await captureCandidates({ text: item.text, apiKey, date: item.date, source: item.source })
      const evaluated = evaluateItem(item, candidates)
      const result = {
        id: item.id,
        source: item.source,
        date: item.date,
        candidates: candidates.map((candidate) => ({
          action: candidate.action,
          debtor: candidate.debtor,
          creditor: candidate.creditor ?? null,
          dueAt: candidate.dueAt ?? null,
          localDue: localDueDate(candidate),
          quote: candidate.quote,
          modal: candidate.modal,
          confirmed: candidate.confirmed === true,
        })),
        expect: item.expect.map((want) => ({ action: want.action, due: want.due ?? null, dueAlt: want.dueAlt ?? null, modal: want.modal, quote: want.quote })),
        matchedExpects: evaluated.matchedExpects.length,
        missing: evaluated.missing,
        dueMismatches: evaluated.dueMismatches,
        modalMismatches: evaluated.modalMismatches,
        unexpectedCandidates: candidates
          .filter((candidate) => !(item.expect || []).some((want) => candidateMatches(candidate, want)))
          .map((candidate) => ({ action: candidate.action, quote: candidate.quote })),
        quoteValid: evaluated.quoteValidCandidates.length,
        candidatesTotal: candidates.length,
        durationMs: Date.now() - started,
      }
      console.error(`${result.matchedExpects === item.expect.length ? 'OK  ' : 'FAIL'} ${item.id}: candidates=${candidates.length} matched=${result.matchedExpects}/${item.expect.length} quoteValid=${result.quoteValid}/${candidates.length} dueMismatch=${result.dueMismatches.length}`)
      return result
    } catch (error) {
      console.error(`ERROR ${item.id}: ${error?.message || error}`)
      return {
        id: item.id,
        source: item.source,
        date: item.date,
        error: String(error?.message || error),
        candidates: [],
        expect: item.expect.map((want) => ({ action: want.action, due: want.due ?? null, dueAlt: want.dueAlt ?? null, modal: want.modal, quote: want.quote })),
        matchedExpects: 0,
        missing: item.expect.map((want) => ({ action: want.action, quote: want.quote, due: want.due ?? null, modal: want.modal })),
        dueMismatches: [],
        modalMismatches: [],
        unexpectedCandidates: [],
        quoteValid: 0,
        candidatesTotal: 0,
        durationMs: Date.now() - started,
      }
    }
  })

  const aggregate = {
    expectTotal: 0,
    matchedExpects: 0,
    firmExpected: 0,
    firmMatched: 0,
    dueChecked: 0,
    dueOk: 0,
    candidatesTotal: 0,
    quoteValidCandidates: 0,
    matchedCandidates: 0,
    autoConfirmed: 0,
  }
  for (const [index, result] of caseResults.entries()) {
    const item = selected[index]
    const evaluated = evaluateItem(item, result.candidates.map((candidate) => ({
      action: candidate.action,
      quote: candidate.quote,
      dueAt: candidate.dueAt,
      modal: candidate.modal,
      confirmed: candidate.confirmed,
    })))
    aggregate.expectTotal += (item.expect || []).length
    aggregate.matchedExpects += evaluated.matchedExpects.length
    aggregate.firmExpected += evaluated.firmExpected
    aggregate.firmMatched += evaluated.firmMatched
    aggregate.dueChecked += evaluated.dueChecked
    aggregate.dueOk += evaluated.dueOk
    aggregate.candidatesTotal += result.candidatesTotal
    aggregate.quoteValidCandidates += result.quoteValid
    aggregate.matchedCandidates += evaluated.matchedCandidates.length
    aggregate.autoConfirmed += evaluated.autoConfirmed
  }

  const metrics = {
    quoteValidity: aggregate.candidatesTotal ? aggregate.quoteValidCandidates / aggregate.candidatesTotal : 1,
    firmRecall: aggregate.firmExpected ? aggregate.firmMatched / aggregate.firmExpected : 1,
    dueAccuracy: aggregate.dueChecked ? aggregate.dueOk / aggregate.dueChecked : 1,
    precision: aggregate.candidatesTotal ? aggregate.matchedCandidates / aggregate.candidatesTotal : 1,
    autoConfirmed: aggregate.autoConfirmed,
  }
  const thresholdFailures = []
  if (metrics.quoteValidity < TARGETS.quoteValidity) thresholdFailures.push(`quote 合法率 ${percent(metrics.quoteValidity)} < ${TARGETS.quoteValidity}`)
  if (aggregate.firmExpected && metrics.firmRecall < TARGETS.firmRecall) thresholdFailures.push(`firm recall ${percent(metrics.firmRecall)} < ${TARGETS.firmRecall}`)
  if (aggregate.dueChecked && metrics.dueAccuracy < TARGETS.dueAccuracy) thresholdFailures.push(`due 准确率 ${percent(metrics.dueAccuracy)} < ${TARGETS.dueAccuracy}`)
  if (aggregate.candidatesTotal && metrics.precision < TARGETS.precision) thresholdFailures.push(`precision ${percent(metrics.precision)} < ${TARGETS.precision}`)
  if (metrics.autoConfirmed > TARGETS.autoConfirmed) thresholdFailures.push(`auto-confirmed ${metrics.autoConfirmed} > ${TARGETS.autoConfirmed}`)

  const failures = caseResults
    .map((result) => {
      const reasons = []
      if (result.error) reasons.push(`error: ${result.error}`)
      for (const missing of result.missing) reasons.push(`missing expect ${missing.action} (${JSON.stringify(missing.quote)})`)
      for (const mismatch of result.dueMismatches) reasons.push(`due mismatch ${mismatch.action}: expected ${mismatch.expected}${mismatch.dueAlt ? `/${mismatch.dueAlt}` : ''}, got ${mismatch.got}`)
      return reasons.length ? { id: result.id, reasons, candidatesTotal: result.candidatesTotal, matchedExpects: result.matchedExpects } : null
    })
    .filter(Boolean)
  const caseErrors = caseResults.filter((result) => result.error).length

  const summary = {
    mode: 'real-model',
    timestamp: new Date().toISOString(),
    disclaimer: defaultSeed ? SEED_STATUS : 'custom corpus; verify human-review status before calling it gold',
    file,
    total: corpus.items.length,
    evaluated: selected.length,
    modelRoute: {
      provider: 'deepseek (via ADVISERS_MODEL/base URL env if set)',
      captureFn: 'packages/advisers/lib/capture.js#captureCandidates',
    },
    seedStatus: defaultSeed ? SEED_STATUS : validationSummary.status,
    distributions: distribution(selected),
    metrics,
    raw: aggregate,
    targets: TARGETS,
    thresholdFailures,
    caseErrors,
    pass: thresholdFailures.length === 0 && caseErrors === 0,
    failures,
    cases: caseResults,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (opts.json) {
    writeFileSync(resolve(opts.json), `${JSON.stringify(summary, null, 2)}\n`)
    console.error(`[gold] JSON 写到 ${resolve(opts.json)}`)
  }
  console.error(`[gold] quote=${percent(metrics.quoteValidity)} firmRecall=${percent(metrics.firmRecall)} (${aggregate.firmMatched}/${aggregate.firmExpected}) due=${percent(metrics.dueAccuracy)} (${aggregate.dueOk}/${aggregate.dueChecked}) precision=${percent(metrics.precision)} (${aggregate.matchedCandidates}/${aggregate.candidatesTotal}) autoConfirmed=${metrics.autoConfirmed}`)
  if (caseErrors) {
    console.error(`[gold] ${caseErrors} 条 capture 调用失败（见 JSON cases[].error）`)
    process.exitCode = 1
  }
  if (thresholdFailures.length) {
    console.error(`[gold] FAIL: ${thresholdFailures.join('; ')}`)
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[fatal] ${error?.stack || error}`)
    process.exitCode = 1
  })
}

export { validateAgainst, validateCorpus, evaluateItem, candidateMatches, TARGETS }
