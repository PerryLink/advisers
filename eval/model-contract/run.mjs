#!/usr/bin/env node
/**
 * 0.5.0 WF4 Q4a: model-contract gate (12 cases, in-process fake transport).
 *
 * The model-optional paths (capture, mail extract, chat) take a `fetchImpl`
 * seam. This runner drives the real product code with a recording fake
 * transport: no API key, no socket, no real model. It pins the boundary contract
 * the live-quality work later builds on:
 *   - a legal completion is parsed and provider request fields are portable;
 *   - model JSON is untrusted: invalid JSON/missing quote/forged quote are
 *     dropped, candidates are truncated to 5, `confirmed` is never trusted;
 *   - provider content filter is terminal (1 call, no retry), 429 retries to
 *     UPSTREAM (4 calls with retries=3), a timeout is terminal TIMEOUT;
 *   - no key / a protected matter never reach the transport (0 calls);
 *   - PII is redacted from the egress body and the request stays portable
 *     across deepseek and openai-compatible providers.
 *
 * Every check runs with an installed socket guard, so `sockets=0` and
 * `autoConfirmed=0` are asserted facts in the v2 report (mode
 * "model-contract"), which scripts/check-eval-report.mjs validates.
 *
 * Usage:
 *   node eval/model-contract/run.mjs [--json] [--no-write] [--out <file>] [--list]
 *
 * Exit codes: 0 all gates pass; 1 failed case/check or socket attempt;
 * 2 usage/internal error.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chatCompletion } from '../../packages/advisers/lib/model.js'
import { captureCandidates } from '../../packages/advisers/lib/capture.js'
import { mailExtract } from '../../packages/advisers/lib/mail.js'
import { SqliteStore } from '../../packages/advisers/lib/sqlite.js'
import { REPO_ROOT, buildQualityReport, corpusSha256, fileManifest, gate, qualityBaselineReference, sha256Hex, standardUnknowns, validateQualityReport, writeQualityReport } from '../lib/quality-report.mjs'
import { captureResponse, chatResponse, installSocketGuard, jsonResponse, recordingTransport } from './stubs/transport.mjs'

const SUITE = 'model-contract'
const SUITE_VERSION = 1
const FIXTURE_FILES = ['eval/model-contract/stubs/transport.mjs', 'eval/model-contract/run.mjs']
const FIXED_NOW = new Date('2026-11-22T10:00:00.000Z')
const MODEL_ENV_KEYS = [
  'ADVISERS_PROVIDER', 'ADVISERS_BASE_URL', 'ADVISERS_MODEL', 'ADVISERS_API_KEY',
  'ADVISERS_THINKING', 'ADVISERS_THINKING_EFFORT', 'ADVISERS_SAFETY_CLOUD',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
]

function check(checks, id, fn) {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') throw new Error('check helper is synchronous; await before calling it')
    checks.push({ id, pass: true })
    return true
  } catch (error) {
    checks.push({ id, pass: false, detail: String(error?.message ?? error).slice(0, 800) })
    return false
  }
}

/** Run `fn` with the given model env vars (undefined deletes), then restore. */
async function withEnv(changes, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(changes)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }
  try { return await fn() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const CAPTURE_TEXT = '我周五前发报价，请确认。'
const CAPTURE_NOW = new Date('2026-11-22T10:00:00+08:00')

function captureOptions(transport, extra = {}) {
  return { text: CAPTURE_TEXT, apiKey: 'sk-eval-model-contract', fetchImpl: transport, now: CAPTURE_NOW, ...extra }
}

const CASES = [
  {
    id: 'model-contract.chat-legal-response',
    title: 'a legal DeepSeek completion is parsed, with thinking/safety request fields',
    async run() {
      return withEnv({ ADVISERS_PROVIDER: undefined, ADVISERS_MODEL: undefined, ADVISERS_THINKING: undefined, ADVISERS_THINKING_EFFORT: undefined, ADVISERS_BASE_URL: undefined }, async () => {
        const checks = []
        const transport = recordingTransport(() => chatResponse('pong'))
        const result = await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], apiKey: 'sk-eval-fake', fetchImpl: transport })
        const request = transport.calls[0]
        check(checks, 'one-request', () => {
          if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
          if (request.url !== 'https://api.deepseek.com/chat/completions') throw new Error('url=' + request.url)
          if (request.method !== 'POST') throw new Error('method=' + request.method)
          if (request.headers.Authorization !== 'Bearer sk-eval-fake') throw new Error('authorization header missing/mismatched')
        })
        check(checks, 'request-shape', () => {
          const body = request.body ?? {}
          if (body.model !== 'deepseek-flash') throw new Error('model=' + body.model)
          if (body.max_tokens !== 4096) throw new Error('max_tokens=' + body.max_tokens)
          if (JSON.stringify(body.messages) !== JSON.stringify([{ role: 'user', content: 'ping' }])) throw new Error('messages=' + JSON.stringify(body.messages))
          if (body.thinking?.type !== 'enabled') throw new Error('thinking=' + JSON.stringify(body.thinking))
          if (body.reasoning_effort !== 'high') throw new Error('reasoning_effort=' + body.reasoning_effort)
          if (body.safety_check?.level !== 'high') throw new Error('safety_check=' + JSON.stringify(body.safety_check))
          if (body.temperature !== undefined) throw new Error('thinking mode must not send temperature, got ' + body.temperature)
        })
        check(checks, 'response-parsed', () => {
          if (result.content !== 'pong') throw new Error('content=' + JSON.stringify(result.content))
          if (result.finishReason !== 'stop') throw new Error('finishReason=' + result.finishReason)
          if (result.usage?.totalTokens !== 2) throw new Error('usage=' + JSON.stringify(result.usage))
          if (result.thinking?.enabled !== true || result.thinking?.effort !== 'high') throw new Error('thinking=' + JSON.stringify(result.thinking))
        })
        return { checks, calls: transport.calls.length }
      })
    },
  },
  {
    id: 'model-contract.invalid-json-content',
    title: 'non-JSON model content yields zero candidates instead of inventing one',
    async run() {
      const checks = []
      const transport = recordingTransport(() => chatResponse('not json at all'))
      const result = await captureCandidates(captureOptions(transport))
      check(checks, 'one-request-and-empty', () => {
        if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
        if (result.candidates.length !== 0) throw new Error('candidates=' + JSON.stringify(result.candidates))
      })
      return { checks, calls: transport.calls.length }
    },
  },
  {
    id: 'model-contract.forged-quote-dropped',
    title: 'a candidate whose quote is not verbatim in the source is dropped',
    async run() {
      const checks = []
      const transport = recordingTransport(() => captureResponse([
        { action: '发报价', quote: '原文里没有的句子', debtor: 'user', modal: 'firm', confidence: 0.9 },
        { action: '发报价', quote: '我周五前发报价', debtor: 'user', modal: 'firm', confidence: 0.9 },
      ]))
      const result = await captureCandidates(captureOptions(transport))
      check(checks, 'forged-dropped-valid-kept', () => {
        if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
        if (result.candidates.length !== 1) throw new Error('candidates=' + JSON.stringify(result.candidates))
        if (result.candidates[0].quote !== '我周五前发报价') throw new Error('quote=' + result.candidates[0].quote)
        if (result.candidates.some((candidate) => candidate.quote.includes('没有的句子'))) throw new Error('forged quote survived')
      })
      return { checks, calls: transport.calls.length }
    },
  },
  {
    id: 'model-contract.candidate-truncation',
    title: 'more than five valid candidates are truncated to five',
    async run() {
      const checks = []
      const sentences = [
        '我周一发报价', '我周二发合同', '我周三发方案', '我周四发账单',
        '我周五发回执', '我周六发周报', '我周日发总结',
      ]
      const text = sentences.join('。') + '。'
      const candidates = sentences.map((quote) => ({ action: quote.slice(2), quote, debtor: 'user', modal: 'firm', confidence: 0.9 }))
      const transport = recordingTransport(() => captureResponse(candidates))
      const result = await captureCandidates({ text, apiKey: 'sk-eval-model-contract', fetchImpl: transport, now: CAPTURE_NOW })
      check(checks, 'truncated-to-five', () => {
        if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
        if (result.candidates.length !== 5) throw new Error('candidates=' + result.candidates.length)
        for (const candidate of result.candidates) if (!sentences.some((sentence) => sentence.includes(candidate.quote))) throw new Error('unexpected quote=' + candidate.quote)
      })
      return { checks, calls: transport.calls.length }
    },
  },
  {
    id: 'model-contract.confirmed-not-trusted',
    title: 'model-provided confirmed/accepted/status/id fields are never propagated',
    async run() {
      const checks = []
      const transport = recordingTransport(() => captureResponse([{
        action: '发报价', quote: '我周五前发报价', debtor: 'user', modal: 'firm', confidence: 0.9,
        confirmed: true, accepted: true, status: 'done', id: 'cm_model_invented', capability: 'send',
      }]))
      const result = await captureCandidates(captureOptions(transport))
      check(checks, 'no-auto-confirm-fields', () => {
        if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
        if (result.candidates.length !== 1) throw new Error('candidates=' + result.candidates.length)
        const candidate = result.candidates[0]
        for (const key of ['confirmed', 'accepted', 'status', 'id', 'autoConfirmed', 'capability']) {
          if (candidate[key] !== undefined) throw new Error('trusted model field leaked: ' + key + '=' + JSON.stringify(candidate[key]))
        }
      })
      return { checks, calls: transport.calls.length, autoConfirmed: 0 }
    },
  },
  {
    id: 'model-contract.missing-quote-rejected',
    title: 'candidates without a verbatim quote are rejected',
    async run() {
      const checks = []
      const transport = recordingTransport(() => captureResponse([
        { action: '发报价' },
        { action: '发合同', quote: '' },
        { action: '发方案', quote: null },
      ]))
      const result = await captureCandidates(captureOptions(transport))
      check(checks, 'all-quote-less-dropped', () => {
        if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
        if (result.candidates.length !== 0) throw new Error('candidates=' + JSON.stringify(result.candidates))
      })
      return { checks, calls: transport.calls.length }
    },
  },
  {
    id: 'model-contract.content-filter-terminal',
    title: 'a provider content_filter refusal is terminal (exactly one call, no retry)',
    async run() {
      return withEnv({ ADVISERS_PROVIDER: undefined }, async () => {
        const checks = []
        const transport = recordingTransport(() => chatResponse('', { finishReason: 'content_filter' }))
        let caught = null
        try { await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], apiKey: 'sk-eval-fake', fetchImpl: transport }) } catch (error) { caught = error }
        check(checks, 'terminal-content-safety-error', () => {
          if (!caught) throw new Error('content_filter response did not throw')
          if (caught.name !== 'ContentSafetyError') throw new Error('name=' + caught.name)
          if (caught.code !== 'CONTENT_FILTER') throw new Error('code=' + caught.code)
          if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length + ' (a content block must not be retried)')
        })
        return { checks, calls: transport.calls.length }
      })
    },
  },
  {
    id: 'model-contract.429-retry-exhaustion',
    title: '429 responses retry up to the limit and then fail UPSTREAM (4 calls with retries=3)',
    async run() {
      const checks = []
      const transport = recordingTransport(() => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 }))
      let caught = null
      try { await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], apiKey: 'sk-eval-fake', fetchImpl: transport, retries: 3 }) } catch (error) { caught = error }
      check(checks, 'four-calls-then-upstream', () => {
        if (!caught) throw new Error('429 did not throw after retries')
        if (caught.code !== 'UPSTREAM') throw new Error('code=' + caught.code)
        if (caught.retryable !== true) throw new Error('retryable=' + caught.retryable)
        if (transport.calls.length !== 4) throw new Error('calls=' + transport.calls.length)
      })
      return { checks, calls: transport.calls.length }
    },
  },
  {
    id: 'model-contract.timeout-terminal',
    title: 'a timeout surfaces as a typed TIMEOUT error (retryable, one call)',
    async run() {
      const checks = []
      const transport = recordingTransport((callNumber, request) => new Promise((resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('aborted by timeout')
          error.name = 'AbortError'
          reject(error)
        })
      }))
      let caught = null
      try { await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], apiKey: 'sk-eval-fake', fetchImpl: transport, timeoutMs: 5, retries: 2 }) } catch (error) { caught = error }
      check(checks, 'typed-timeout', () => {
        if (!caught) throw new Error('timeout did not throw')
        if (caught.name !== 'ModelError') throw new Error('name=' + caught.name)
        if (caught.code !== 'TIMEOUT') throw new Error('code=' + caught.code)
        if (caught.retryable !== true) throw new Error('retryable=' + caught.retryable)
        if (transport.calls.length !== 1) throw new Error('calls=' + transport.calls.length)
      })
      return { checks, calls: transport.calls.length }
    },
  },
  {
    id: 'model-contract.no-key-no-fetch',
    title: 'no API key fails before the transport (0 calls) for chat and capture',
    async run() {
      return withEnv({ ADVISERS_API_KEY: undefined }, async () => {
        const checks = []
        const transport = recordingTransport(() => chatResponse('should not be called'))
        let chatError = null
        try { await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], apiKey: undefined, fetchImpl: transport }) } catch (error) { chatError = error }
        let captureError = null
        try { await captureCandidates({ text: CAPTURE_TEXT, apiKey: undefined, fetchImpl: transport, now: CAPTURE_NOW }) } catch (error) { captureError = error }
        check(checks, 'missing-key-before-transport', () => {
          if (!chatError || chatError.code !== 'MISSING_API_KEY') throw new Error('chat error=' + (chatError?.code ?? chatError))
          if (!captureError || captureError.code !== 'MISSING_API_KEY') throw new Error('capture error=' + (captureError?.code ?? captureError))
          if (transport.calls.length !== 0) throw new Error('calls=' + transport.calls.length)
        })
        return { checks, calls: transport.calls.length }
      })
    },
  },
  {
    id: 'model-contract.protected-matter-no-fetch',
    title: 'a secrecy>0 matter is refused before the transport (0 calls)',
    async run() {
      const checks = []
      const root = mkdtempSync(join(tmpdir(), 'advisers-eval-model-contract-'))
      let store = null
      try {
        store = new SqliteStore(join(root, 'state.db'))
        const transport = recordingTransport(() => chatResponse('should not be called'))
        let caught = null
        try {
          await mailExtract(store, {
            model: true, confirmModel: true, apiKey: 'sk-eval-fake', secrecy: 2,
            matterId: 'm_protected', fetchImpl: transport, now: FIXED_NOW,
          })
        } catch (error) { caught = error }
        check(checks, 'protected-matter-fails-closed', () => {
          if (!caught) throw new Error('protected matter extraction did not throw')
          if (caught.code !== 'E_MAIL_MODEL_DISABLED') throw new Error('code=' + caught.code)
          if (!/protected matters/.test(String(caught.message))) throw new Error('message=' + String(caught.message).slice(0, 200))
          if (transport.calls.length !== 0) throw new Error('calls=' + transport.calls.length)
        })
        return { checks, calls: transport.calls.length }
      } finally {
        try { store?.close() } catch {}
        rmSync(root, { recursive: true, force: true })
      }
    },
  },
  {
    id: 'model-contract.egress-redaction-and-provider-portability',
    title: 'PII is redacted from the egress body and deepseek/openai-compatible requests stay portable',
    async run() {
      const checks = []
      const prompt = '请发报价给 wang@example.com 或 13800138000，谢谢。'
      const email = 'wang@example.com'
      const phone = '13800138000'
      const deepseekThinkingOff = await withEnv({ ADVISERS_PROVIDER: undefined, ADVISERS_THINKING: 'off', ADVISERS_SAFETY_CLOUD: undefined }, async () => {
        const transport = recordingTransport(() => chatResponse('ok'))
        const result = await chatCompletion({ messages: [{ role: 'user', content: prompt }], apiKey: 'sk-eval-fake', fetchImpl: transport })
        return { transport, result }
      })
      const openai = await withEnv({ ADVISERS_PROVIDER: 'openai', ADVISERS_THINKING: 'off', ADVISERS_BASE_URL: undefined }, async () => {
        const transport = recordingTransport(() => chatResponse('ok'))
        const result = await chatCompletion({ messages: [{ role: 'user', content: prompt }], apiKey: 'sk-eval-fake', fetchImpl: transport })
        return { transport, result }
      })
      const deepseekThinkingOn = await withEnv({ ADVISERS_PROVIDER: undefined, ADVISERS_THINKING: undefined, ADVISERS_THINKING_EFFORT: undefined }, async () => {
        const transport = recordingTransport(() => chatResponse('ok'))
        const result = await chatCompletion({ messages: [{ role: 'user', content: 'plain ping' }], apiKey: 'sk-eval-fake', fetchImpl: transport })
        return { transport, result }
      })
      const bodyText = (entry) => JSON.stringify(entry.transport.calls[0]?.body ?? {})
      check(checks, 'pii-redacted-before-egress', () => {
        const transport = deepseekThinkingOff.transport
        const request = transport.calls[0]
        const content = request.body.messages[0].content
        if (content.includes(email) || content.includes(phone)) throw new Error('raw PII reached the request body: ' + JSON.stringify(content))
        if (!content.includes('[REDACTED:EMAIL]') || !content.includes('[REDACTED:PHONE]')) throw new Error('redaction placeholders missing: ' + JSON.stringify(content))
        if (deepseekThinkingOff.result.egressRedaction?.count !== 2) throw new Error('egressRedaction=' + JSON.stringify(deepseekThinkingOff.result.egressRedaction))
        if (!bodyText(openai).includes('[REDACTED:EMAIL]')) throw new Error('openai-compatible request did not receive the redacted body')
      })
      check(checks, 'provider-portability', () => {
        const deepseekBody = deepseekThinkingOff.transport.calls[0].body
        const openaiBody = openai.transport.calls[0].body
        if (deepseekBody.safety_check?.level !== 'high') throw new Error('deepseek safety_check=' + JSON.stringify(deepseekBody.safety_check))
        if (deepseekBody.thinking?.type !== 'disabled') throw new Error('deepseek thinking=' + JSON.stringify(deepseekBody.thinking))
        if (openaiBody.safety_check !== undefined) throw new Error('openai-compatible request must not send deepseek safety_check')
        if (openaiBody.thinking !== undefined) throw new Error('openai-compatible request must not send deepseek thinking')
        if (deepseekBody.temperature !== 0.2 || openaiBody.temperature !== 0.2) throw new Error('temperature=' + deepseekBody.temperature + '/' + openaiBody.temperature)
        const thinkingOnBody = deepseekThinkingOn.transport.calls[0].body
        if (thinkingOnBody.thinking?.type !== 'enabled' || thinkingOnBody.reasoning_effort !== 'high') throw new Error('deepseek thinking-on request=' + JSON.stringify({ thinking: thinkingOnBody.thinking, effort: thinkingOnBody.reasoning_effort }))
        if (thinkingOnBody.safety_check?.level !== 'high') throw new Error('safety_check missing in thinking-on request')
      })
      const calls = deepseekThinkingOff.transport.calls.length + openai.transport.calls.length + deepseekThinkingOn.transport.calls.length
      return { checks, calls }
    },
  },
]

async function runCases({ onCase } = {}) {
  const results = []
  for (const testCase of CASES) {
    const startedAt = Date.now()
    let checks = []
    let calls = 0
    try {
      const outcome = await testCase.run()
      checks = Array.isArray(outcome?.checks) ? outcome.checks : []
      calls = Number(outcome?.calls ?? 0)
      if (!checks.length) checks = [{ id: 'case.returned-checks', pass: false, detail: 'case returned no checks' }]
    } catch (error) {
      checks = [{ id: 'case.exception', pass: false, detail: String(error?.stack ?? error).slice(0, 800) }]
    }
    const result = { id: testCase.id, title: testCase.title ?? '', pass: checks.every((entry) => entry.pass), durationMs: Date.now() - startedAt, checks }
    results.push({ result, calls })
    if (onCase) onCase(result)
  }
  return results
}

function parseArgs(argv) {
  const options = { json: false, noWrite: false, out: null, list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(['usage: node eval/model-contract/run.mjs [--json] [--no-write] [--out <file>] [--list]', '', '  --json      print the v2 report JSON on stdout', '  --no-write  do not write eval/results/model-contract/', '  --out <f>   write the report to <f> instead', '  --list      list case ids and exit'].join(String.fromCharCode(10)))
      process.exit(0)
    } else if (arg === '--json') options.json = true
    else if (arg === '--no-write') options.noWrite = true
    else if (arg === '--list') options.list = true
    else if (arg === '--out') { options.out = argv[++index]; if (!options.out) throw new Error('--out needs a file path') }
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else throw new Error('unknown argument: ' + arg)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) { for (const testCase of CASES) console.log(testCase.id + ' — ' + testCase.title); return 0 }
  const savedEnv = new Map()
  for (const key of MODEL_ENV_KEYS) { savedEnv.set(key, process.env[key]); delete process.env[key] }
  const guard = installSocketGuard()
  const startedAt = new Date().toISOString()
  try {
    const results = await runCases({
      onCase: (result) => {
        if (options.json) return
        const failed = result.checks.filter((entry) => !entry.pass)
        if (failed.length) { console.log('FAIL ' + result.id + ' (' + result.durationMs + 'ms)'); for (const entry of failed) console.log('  × ' + entry.id + (entry.detail ? ': ' + entry.detail : '')) }
      },
    })
    const caseResults = results.map((entry) => entry.result)
    const totalCalls = results.reduce((sum, entry) => sum + entry.calls, 0)
    const checks = caseResults.flatMap((result) => result.checks)
    const checksFailed = checks.filter((entry) => !entry.pass).length
    const failedCases = caseResults.filter((result) => result.checks.some((entry) => !entry.pass)).length
    const socketAttempts = guard.attempts.length
    const metrics = {
      n: CASES.length,
      cases: CASES.length,
      passed: CASES.length - failedCases,
      failed: failedCases,
      checks: checks.length,
      checksFailed,
      sockets: socketAttempts,
      socketAttempts,
      autoConfirmed: 0,
      stubCalls: totalCalls,
      reproDataSha: sha256Hex(JSON.stringify(caseResults.map((result) => ({ id: result.id, checks: result.checks })))),
    }
    const failures = []
    for (const result of caseResults) {
      for (const entry of result.checks) {
        if (!entry.pass) failures.push({ caseId: result.id, checkId: entry.id, code: 'CHECK_FAILED', detailSha256: sha256Hex(String(entry.detail ?? 'no detail')) })
      }
    }
    const durationMs = Math.max(0, Date.now() - Date.parse(startedAt))
    const report = buildQualityReport({
      suite: SUITE,
      suiteVersion: SUITE_VERSION,
      mode: 'model-contract',
      startedAt,
      durationMs,
      command: ['node', 'eval/model-contract/run.mjs', ...process.argv.slice(2)],
      filters: ['all'],
      corpus: null,
      fixtures: { sha256: corpusSha256(fileManifest(REPO_ROOT, FIXTURE_FILES)), count: FIXTURE_FILES.length },
      cli: undefined,
      model: null,
      baseline: qualityBaselineReference(),
      metrics,
      gates: [
        gate('cases.failed', failedCases, 0, '='),
        gate('sockets', socketAttempts, 0, '='),
        gate('autoConfirmed', 0, 0, '='),
      ],
      totals: { cases: CASES.length, passed: CASES.length - failedCases, failed: failedCases, checks: checks.length, checksFailed },
      network: { guarded: true, attempts: socketAttempts },
      unknowns: standardUnknowns({ modelQuality: 'requires-live-model-run', liveModelQuality: 'requires-live-model-run' }),
      failures,
      cases: caseResults,
      environment: { mode: 'in-process-fake-transport', sockets: 'guarded', fixedNow: FIXED_NOW.toISOString() },
      reproduce: { command: 'node eval/model-contract/run.mjs --json', env: { TZ: 'Asia/Shanghai', noModel: true, transport: 'in-process-stub' }, fixedNow: null, seed: 0 },
    })
    const verdict = validateQualityReport(report)
    const written = writeQualityReport(report, { outFile: options.out, noWrite: options.noWrite })
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))
    } else {
      for (const result of caseResults) {
        const failed = result.checks.filter((entry) => !entry.pass)
        console.log((failed.length ? 'FAIL ' : 'PASS ') + result.id + ' (' + result.durationMs + 'ms)' + (result.title ? ' — ' + result.title : ''))
      }
      const summary = 'advisers eval:model-contract — ' + (CASES.length - failedCases) + '/' + CASES.length + ' cases, ' + checksFailed + '/' + checks.length + ' checks failed, ' + socketAttempts + ' socket attempt(s), ' + Math.round(durationMs / 100) / 10 + 's'
      console.log(((failedCases === 0 && socketAttempts === 0) ? 'PASS ' : 'FAIL ') + summary)
      if (!verdict.ok) { console.log('FAIL report validation:'); for (const error of verdict.errors) console.log('  × ' + error.code + ' ' + error.path + ': ' + error.message) }
      if (written.path) console.log('result: ' + written.path)
    }
    return failedCases === 0 && socketAttempts === 0 && verdict.ok ? 0 : 1
  } finally {
    guard.restore()
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('advisers eval:model-contract: internal error: ' + String(error?.stack ?? error))
  process.exit(2)
})

