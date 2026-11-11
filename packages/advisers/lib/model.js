/**
 * Minimal OpenAI-compatible chat completion with tool-call support.
 * The key is read from the environment and never logged or persisted.
 */
export async function chatCompletion({
  messages,
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-chat',
  temperature = 0.2,
  tools,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('missing API key')
  const body = { model, temperature, messages }
  if (tools?.length) body.tools = tools
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`model HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  const data = await response.json()
  const message = data?.choices?.[0]?.message
  if (!message) throw new Error('model returned no message')
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: data.usage,
  }
}

export async function complete({ prompt, ...options }) {
  const result = await chatCompletion({ messages: [{ role: 'user', content: prompt }], ...options })
  return result.content
}
