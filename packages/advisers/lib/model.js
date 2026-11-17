/**
 * Minimal OpenAI-compatible chat completion with tool-call support.
 * The key is read from the environment and never logged or persisted.
 * Thinking-mode reasoning_content is returned only as wire state; callers must
 * never persist it or expose it as evidence.
 */
import {
  inspectMessages,
  normalizeProviderRefusal,
  safetyErrorFrom,
  buildAuditReason,
} from './safety/index.js'

const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
const EFFORTS = new Set(['low', 'high', 'max'])

export function normalizeEffort(value) {
  const v = String(value || '').toLowerCase()
  if (v === 'minimal' || v === 'low') return 'low'
  if (v === 'medium' || v === 'high' || v === 'xhigh') return 'high'
  if (v === 'ultra' || v === 'max') return 'max'
  return undefined
}

const TASK_EFFORT = {
  chat: 'low',
  bridge: 'low',
  summarize: 'low',
  review: 'high',
  agent: 'high',
  capture: 'high',
  office_check: 'high',
  intent: 'low',
  max: 'max',
}

// ---------------------------------------------------------------------------
// content safety (local rule layer; never sends the original text anywhere)
//
// chatCompletion is the single choke point for every model call (chat, agent,
// capture, review, doc-review). Outbound messages and the returned assistant
// message are classified locally before/after the request:
//   block                -> ContentSafetyError (code/ruleIds/rulesetVersion,
//                           message has no original text; no network request is
//                           made for a blocked request)
//   warn/confirm/redact  -> request proceeds, safetyWarnings is attached to
//                           the result (additive optional field)
// The classifier surface is model.output (the registered surface for
// model-bound text; egress, no local-file downgrade). Wiring is documented in
// docs/CONTENT-SAFETY.md section 8.
// ---------------------------------------------------------------------------
const SAFETY_SURFACE = 'model.output'
/** Disable the optional DeepSeek safety_check network-side gate with '0'. */
const SAFETY_CLOUD_ENV = 'ADVISERS_SAFETY_CLOUD'

function safetyWarningOf(result, direction) {
  if (!result || result.action === 'allow') return null
  const surface = result.surface || SAFETY_SURFACE
  const ruleIds = Array.isArray(result.ruleIds) ? [...result.ruleIds] : []
  const auditReason = buildAuditReason({
    rulesetVersion: result.rulesetVersion,
    surface,
    action: result.action,
    code: result.code,
    ruleIds,
    evidenceHash: result.evidenceHash,
  })
  return {
    direction,
    action: result.action,
    code: result.code,
    categories: Array.isArray(result.categories) ? [...result.categories] : [],
    ruleIds,
    surface,
    rulesetVersion: result.rulesetVersion,
    evidenceHash: result.evidenceHash || null,
    crisis: Boolean(result.crisis),
    auditReason,
  }
}

function safetyWarningsOf(result, direction) {
  const warning = safetyWarningOf(result, direction)
  return warning ? [warning] : []
}

/** Throw a typed, text-free error for a blocked pre-request classification. */
function throwIfBlocked(result, provider, direction) {
  if (!result || result.action !== 'block') return
  const error = safetyErrorFrom(result, { provider, surface: SAFETY_SURFACE })
  error.direction = direction
  throw error
}

/** Map a provider-side refusal/400 to a typed, text-free ContentSafetyError. */
function throwIfProviderRefused(payload, { provider, status, direction }) {
  const refusal = normalizeProviderRefusal(payload, { status })
  if (!refusal.blocked) return
  const error = safetyErrorFrom(
    { action: 'block', code: refusal.code, categories: [], ruleIds: [], surface: SAFETY_SURFACE, evidenceHash: null },
    { provider: refusal.provider || provider, surface: SAFETY_SURFACE },
  )
  error.direction = direction
  error.protocol = refusal.protocol
  error.safetyTokens = refusal.safetyTokens
  if (refusal.imagesBlocked?.length) error.imagesBlocked = [...refusal.imagesBlocked]
  throw error
}

function cloudSafetyEnabled(env = process.env) {
  const raw = String(env[SAFETY_CLOUD_ENV] ?? '').trim().toLowerCase()
  if (!raw) return true
  return !['0', 'off', 'false', 'no', 'disabled'].includes(raw)
}

/** Explicit option > env default; DeepSeek-only (other providers stay portable). */
function resolveCloudSafety(safetyCheck, env = process.env) {
  if (safetyCheck === false) return null
  if (safetyCheck === true) return { level: 'high' }
  if (safetyCheck && typeof safetyCheck === 'object') return safetyCheck
  return cloudSafetyEnabled(env) ? { level: 'high' } : null
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text ?? ''))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function resolveThinking({ task = 'agent', explicit, env = process.env } = {}) {
  const mode = String(env.ADVISERS_THINKING || 'auto').toLowerCase()
  const explicitEffort = normalizeEffort(explicit ?? env.ADVISERS_THINKING_EFFORT)
  if (mode === 'off' || explicitEffort === 'off') return { enabled: false, effort: undefined, source: 'off' }
  if (explicitEffort) return { enabled: true, effort: explicitEffort, source: 'explicit' }
  if (mode === 'on') return { enabled: true, effort: TASK_EFFORT[task] || 'high', source: 'on' }
  return { enabled: true, effort: TASK_EFFORT[task] || 'high', source: 'auto' }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0)
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    completionTokens: completion,
    reasoningTokens: reasoning,
    cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    safetyTokens: Number(
      usage.completion_tokens_details?.safety_tokens
      ?? usage.output_tokens_details?.safety_tokens
      ?? usage.input_tokens_details?.safety_tokens
      ?? usage.safety_tokens
      ?? 0,
    ) || 0,
  }
}

export class ModelError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message)
    this.name = 'ModelError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export async function chatCompletion({
  messages,
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = process.env.ADVISERS_MODEL || 'deepseek-flash',
  temperature = 0.2,
  tools,
  fetchImpl = fetch,
  maxTokens = Number(process.env.ADVISERS_MAX_TOKENS) || 4096,
  timeoutMs = Number(process.env.ADVISERS_MODEL_TIMEOUT_MS) || 60_000,
  retries = 2,
  task = 'agent',
  thinking,
  effort,
  signal,
  safetyKey,
  safetyCheck,
}) {
  if (!apiKey) throw new ModelError('missing API key', { code: 'MISSING_API_KEY' })
  const policy = thinking === false ? { enabled: false } : { enabled: true, ...resolveThinking({ task, explicit: effort }) }
  if (thinking === true && !policy.enabled) policy.enabled = true
  const provider = (process.env.ADVISERS_PROVIDER || 'deepseek').toLowerCase()

  // Local pre-flight classification: a blocked request never reaches the network.
  const requestSafety = inspectMessages(messages, { surface: SAFETY_SURFACE, hmacKey: safetyKey })
  throwIfBlocked(requestSafety, provider, 'input')
  const safetyWarnings = safetyWarningsOf(requestSafety, 'input')

  const body = { model, messages, max_tokens: maxTokens }
  if (tools?.length) body.tools = tools
  if (provider === 'deepseek') {
    // Optional network-side second net (DeepSeek supports safety_check on the
    // chat completions endpoint; default on for this provider only). Set
    // ADVISERS_SAFETY_CLOUD=0 to disable. Live compatibility is tracked as a
    // documented TODO — the parameter is only added for the DeepSeek provider.
    const cloudSafety = resolveCloudSafety(safetyCheck)
    if (cloudSafety) body.safety_check = cloudSafety
    if (policy.enabled) {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = normalizeEffort(policy.effort) || 'high'
    } else {
      body.thinking = { type: 'disabled' }
      body.temperature = temperature
    }
  } else {
    // OpenAI-compatible providers (OpenAI, Ollama /v1, LM Studio, vLLM) do not
    // understand DeepSeek's thinking fields; keep the request portable.
    body.temperature = temperature
  }
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        // Upstream content-risk refusals become typed ContentSafetyErrors (the
        // upstream body is never copied into the error). Other HTTP errors keep
        // their existing ModelError shape and retry policy.
        if (provider === 'deepseek') {
          throwIfProviderRefused(parseJsonObject(text) ?? { error: { message: text } }, {
            provider,
            status: response.status,
            direction: 'input',
          })
        }
        const retryable = RETRY_STATUS.has(response.status)
        const error = new ModelError(`model HTTP ${response.status}`, { status: response.status, code: response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 400 ? 'INVALID_REQUEST' : 'UPSTREAM', retryable })
        error.body = text
        if (!retryable || attempt === retries) throw error
        lastError = error
      } else {
        const data = await response.json()
        // Documented rejection shapes (finish_reason=content_filter,
        // stop_reason=refusal, message.refusal, image blocks) fail closed.
        throwIfProviderRefused(data, { provider, status: response.status, direction: 'output' })
        const choice = data?.choices?.[0]
        const message = choice?.message
        if (!message) throw new ModelError('model returned no message', { code: 'EMPTY_RESPONSE' })
        const content = typeof message.content === 'string' ? message.content : ''
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        // Post-flight classification of the assistant message (text + tool args).
        const outputSafety = inspectMessages([{ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }], {
          surface: SAFETY_SURFACE,
          hmacKey: safetyKey,
        })
        throwIfBlocked(outputSafety, provider, 'output')
        safetyWarnings.push(...safetyWarningsOf(outputSafety, 'output'))
        return {
          content,
          reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
          toolCalls,
          finishReason: choice?.finish_reason,
          usage: normalizeUsage(data.usage),
          thinking: policy,
          model,
          ...(safetyWarnings.length ? { safetyWarnings } : {}),
        }
      }
    } catch (error) {
      // A content-safety block is terminal: never retried, never forwarded.
      if (error?.name === 'ContentSafetyError') throw error
      lastError = error
      if (signal?.aborted) throw new ModelError('cancelled by user', { code: 'CANCELLED_BY_USER' })
      if (error.name === 'AbortError') throw new ModelError(`model timeout after ${timeoutMs}ms`, { code: 'TIMEOUT', retryable: true })
      if (error instanceof ModelError && !error.retryable) throw error
      if (attempt === retries) throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    await sleep(400 * 2 ** attempt)
  }
  throw lastError ?? new ModelError('model request failed', { code: 'UPSTREAM' })
}

export function modelProvider() {
  return { provider: (process.env.ADVISERS_PROVIDER || 'deepseek').toLowerCase(), baseUrl: process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com', model: process.env.ADVISERS_MODEL || 'deepseek-flash' }
}

export async function complete({ prompt, ...options }) {
  const result = await chatCompletion({ messages: [{ role: 'user', content: prompt }], ...options })
  return result.content
}
