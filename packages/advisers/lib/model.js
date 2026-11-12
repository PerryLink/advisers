/**
 * Minimal OpenAI-compatible chat completion with tool-call support.
 * The key is read from the environment and never logged or persisted.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function chatCompletion({
  messages,
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-chat',
  temperature = 0.2,
  tools,
  fetchImpl = fetch,
  maxTokens = Number(process.env.ADVISERS_MAX_TOKENS) || 4096,
  timeoutMs = Number(process.env.ADVISERS_MODEL_TIMEOUT_MS) || 60_000,
  retries = 2,
}) {
  if (!apiKey) throw new Error('missing API key')
  const body = { model, temperature, messages, max_tokens: maxTokens }
  if (tools?.length) body.tools = tools
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = new Error(`model HTTP ${response.status}: ${text.slice(0, 300)}`)
        error.status = response.status
        if (!RETRY_STATUS.has(response.status) || attempt === retries) throw error
        lastError = error
      } else {
        const data = await response.json()
        const message = data?.choices?.[0]?.message
        if (!message) throw new Error('model returned no message')
        return {
          content: typeof message.content === 'string' ? message.content : '',
          toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
          usage: data.usage,
        }
      }
    } catch (error) {
      lastError = error
      if (error.name === 'AbortError') throw new Error(`model timeout after ${timeoutMs}ms`)
      if (error.status && !RETRY_STATUS.has(error.status)) throw error
      if (attempt === retries) throw error
    } finally {
      clearTimeout(timer)
    }
    await sleep(400 * 2 ** attempt)
  }
  throw lastError ?? new Error('model request failed')
}

export async function complete({ prompt, ...options }) {
  const result = await chatCompletion({ messages: [{ role: 'user', content: prompt }], ...options })
  return result.content
}
