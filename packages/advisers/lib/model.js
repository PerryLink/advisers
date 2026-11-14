/**
 * Minimal OpenAI-compatible chat completion with tool-call support.
 * The key is read from the environment and never logged or persisted.
 * Thinking-mode reasoning_content is returned only as wire state; callers must
 * never persist it or expose it as evidence.
 */
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
}) {
  if (!apiKey) throw new ModelError('missing API key', { code: 'MISSING_API_KEY' })
  const policy = thinking === false ? { enabled: false } : { enabled: true, ...resolveThinking({ task, explicit: effort }) }
  if (thinking === true && !policy.enabled) policy.enabled = true
  const provider = (process.env.ADVISERS_PROVIDER || 'deepseek').toLowerCase()
  const body = { model, messages, max_tokens: maxTokens }
  if (tools?.length) body.tools = tools
  if (provider === 'deepseek') {
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
        const retryable = RETRY_STATUS.has(response.status)
        const error = new ModelError(`model HTTP ${response.status}`, { status: response.status, code: response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 400 ? 'INVALID_REQUEST' : 'UPSTREAM', retryable })
        error.body = text
        if (!retryable || attempt === retries) throw error
        lastError = error
      } else {
        const data = await response.json()
        const choice = data?.choices?.[0]
        const message = choice?.message
        if (!message) throw new ModelError('model returned no message', { code: 'EMPTY_RESPONSE' })
        return {
          content: typeof message.content === 'string' ? message.content : '',
          reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
          toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
          finishReason: choice?.finish_reason,
          usage: normalizeUsage(data.usage),
          thinking: policy,
          model,
        }
      }
    } catch (error) {
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
