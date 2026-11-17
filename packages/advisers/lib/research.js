/**
 * DeepSeek server-side web tools (Messages API).
 * Search and URL reading run on the service; no local tool is executed.
 * Citations are provider output, not local evidence.
 *
 * Network hardening (2026-11-17 robustness audit P1-5): every request has an
 * AbortController timeout, a hard wall-clock deadline that does not depend on
 * the fetch implementation honoring the signal, and bounded retries for
 * 429/5xx (same policy as lib/model.js).
 *
 * Content safety (0.2.0): the query/URL text is classified locally BEFORE any
 * network request (surface research.query); a block throws ContentSafetyError
 * and no fetch happens. A model answer that is flagged is returned as-is with
 * an additive safetyWarnings field (the provider call already happened; the
 * design keeps research output at warn, never a silent rewrite). The protected
 * matter egress gate lives in the CLI (lib/egress.js) and is unchanged.
 */
import { classify, safetyErrorFrom, buildAuditReason } from './safety/index.js'

const MAX_TOKENS = 4096
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

const RESEARCH_INPUT_SURFACE = 'research.query'
const RESEARCH_OUTPUT_SURFACE = 'research.output'

function safetyWarningOf(result, direction) {
  if (!result || result.action === 'allow') return null
  const surface = result.surface || RESEARCH_INPUT_SURFACE
  const ruleIds = Array.isArray(result.ruleIds) ? [...result.ruleIds] : []
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
    auditReason: buildAuditReason({
      rulesetVersion: result.rulesetVersion,
      surface,
      action: result.action,
      code: result.code,
      ruleIds,
      evidenceHash: result.evidenceHash,
    }),
  }
}

function root(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  return base.endsWith('/anthropic/v1') ? base : `${base}/anthropic/v1`
}

function normalizeSources(blocks = []) {
  const sources = []
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.type !== 'web_search_result') continue
        sources.push({ url: result.url, title: result.title ?? null, pageAge: result.page_age ?? null, snippet: result.snippet ?? null, siteName: result.site_name ?? null, kind: 'search' })
      }
    }
    if (block.type === 'web_fetch_tool_result') {
      const content = block.content?.type === 'web_fetch_result' ? block.content : null
      if (content) sources.push({ url: content.url, title: content.content?.title ?? null, pageAge: content.published_at ?? null, snippet: null, siteName: null, kind: block.kind ?? 'read_link' })
    }
  }
  return sources
}

function normalizeCitations(blocks = []) {
  const citations = []
  for (const block of blocks) {
    if (block.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const c of block.citations) citations.push({ url: c.url, title: c.title ?? null, citedText: c.cited_text ?? '' })
  }
  return citations
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ResearchError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message)
    this.name = 'ResearchError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export async function research({
  query, urls = [], apiKey, baseUrl, fetchImpl = fetch, deep = false, maxTokens = MAX_TOKENS,
  timeoutMs = Number(process.env.ADVISERS_RESEARCH_TIMEOUT_MS) || 60_000,
  retries = 2,
  signal,
  safetyKey,
}) {
  if (!apiKey) throw new ResearchError('research requires ADVISERS_API_KEY', { code: 'MISSING_API_KEY' })
  const text = [String(query || '').trim(), ...urls].filter(Boolean).join('\n')
  if (!text) throw new ResearchError('research requires a query or URL', { code: 'INVALID_REQUEST' })
  // Local pre-flight check: a blocked query/URL never opens a network request.
  const requestSafety = classify(text, { surface: RESEARCH_INPUT_SURFACE, hmacKey: safetyKey })
  if (requestSafety.action === 'block') throw safetyErrorFrom(requestSafety, { surface: RESEARCH_INPUT_SURFACE, provider: 'deepseek' })
  const safetyWarnings = []
  const requestWarning = safetyWarningOf(requestSafety, 'input')
  if (requestWarning) safetyWarnings.push(requestWarning)
  const tools = urls.length
    ? [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }]
    : [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }]
  const body = {
    model: process.env.ADVISERS_MODEL || 'deepseek-flash',
    max_tokens: maxTokens,
    thinking: { type: deep ? 'enabled' : 'disabled' },
    tools,
    messages: [{ role: 'user', content: text }],
  }
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    let timer
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    // Race the fetch against a wall-clock deadline so a hung fetchImpl cannot
    // keep the CLI (or a test) waiting forever even if it ignores the signal.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new ResearchError(`research timeout after ${timeoutMs}ms`, { code: 'TIMEOUT' }))
      }, timeoutMs)
      // The deadline timer must stay referenced: a fetch implementation that
      // ignores the abort signal may leave the event loop empty, and an unref'd
      // timer would never fire (Node 22 treats that as a pending promise at exit).
    })
    try {
      const request = fetchImpl(`${root(baseUrl)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      // Avoid an unhandled rejection when the deadline wins the race.
      request.catch?.(() => {})
      const response = await Promise.race([request, deadline])
      if (!response.ok) {
        // Never copy the upstream body into the error message (privacy audit
        // P1-2, 2026-11-17). A provider 401 can echo the submitted API key and
        // the body may contain control characters; both used to reach stderr,
        // CI logs and screenshots through the uncaught error. Only stable
        // fields (status + code) are kept. The body is discarded.
        try { await response.body?.cancel?.() } catch {}
        const retryable = RETRY_STATUS.has(response.status)
        const code = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMITED' : response.status === 400 ? 'INVALID_REQUEST' : 'UPSTREAM'
        const error = new ResearchError(`research HTTP ${response.status} (${code})`, {
          status: response.status,
          code,
          retryable,
        })
        if (!retryable || attempt === retries) throw error
        lastError = error
      } else {
        const data = await response.json()
        const blocks = Array.isArray(data.content) ? data.content : []
        const answer = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        const sources = normalizeSources(blocks)
        const citations = normalizeCitations(blocks)
        if (data.stop_reason === 'refusal') throw new ResearchError('research refused by provider safety review', { code: 'REFUSAL' })
        // Output stays at warn: the response already exists, so it is not
        // rewritten; callers get an additive safetyWarnings field instead.
        const answerWarning = safetyWarningOf(classify(answer, { surface: RESEARCH_OUTPUT_SURFACE, hmacKey: safetyKey }), 'output')
        if (answerWarning) safetyWarnings.push(answerWarning)
        return {
          answer,
          sources,
          citations,
          usage: data.usage,
          stopReason: data.stop_reason,
          blocks,
          ...(safetyWarnings.length ? { safetyWarnings } : {}),
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new ResearchError('research cancelled by user', { code: 'CANCELLED_BY_USER' })
      if (error?.name === 'AbortError') throw new ResearchError(`research timeout after ${timeoutMs}ms`, { code: 'TIMEOUT' })
      if (error instanceof ResearchError && !error.retryable) throw error
      lastError = error
      if (attempt === retries) throw error
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    await sleep(400 * 2 ** attempt)
  }
  throw lastError ?? new ResearchError('research request failed', { code: 'UPSTREAM' })
}
