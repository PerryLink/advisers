/**
 * DeepSeek server-side web tools (Messages API).
 * Search and URL reading run on the service; no local tool is executed.
 * Citations are provider output, not local evidence.
 */
const MAX_TOKENS = 4096

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

export async function research({ query, urls = [], apiKey, baseUrl, fetchImpl = fetch, deep = false, maxTokens = MAX_TOKENS }) {
  if (!apiKey) throw new Error('research requires ADVISERS_API_KEY')
  const text = [String(query || '').trim(), ...urls].filter(Boolean).join('\n')
  if (!text) throw new Error('research requires a query or URL')
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
  const response = await fetchImpl(`${root(baseUrl)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new Error(`research HTTP ${response.status}: ${raw.slice(0, 300)}`)
  }
  const data = await response.json()
  const blocks = Array.isArray(data.content) ? data.content : []
  const answer = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
  const sources = normalizeSources(blocks)
  const citations = normalizeCitations(blocks)
  if (data.stop_reason === 'refusal') throw new Error('research refused by provider safety review')
  return { answer, sources, citations, usage: data.usage, stopReason: data.stop_reason, blocks }
}
