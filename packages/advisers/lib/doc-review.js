import { chatCompletion } from './model.js'

const MAX_INPUT = 20_000

export function parseDocReview(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { findings: [], summary: '', invalid: true } }
  const findings = Array.isArray(parsed?.findings) ? parsed.findings.slice(0, 8).map((f) => ({
    severity: f.severity === 'blocker' ? 'blocker' : 'warn',
    message: String(f.message || '').slice(0, 200),
    evidence: String(f.evidence || '').slice(0, 160),
  })).filter((f) => f.message) : []
  return { findings, summary: String(parsed?.summary || '').slice(0, 300), invalid: false }
}

export async function reviewDocument({ text, request, apiKey, baseUrl, model, fetchImpl = fetch }) {
  const input = String(text || '').slice(0, MAX_INPUT)
  if (!input.trim()) throw new Error('document has no readable text')
  if (!apiKey) throw new Error('document review requires ADVISERS_API_KEY')
  const response = await chatCompletion({
    apiKey, baseUrl, model, fetchImpl,
    task: 'review', thinking: true, effort: 'high', maxTokens: 4096,
    messages: [
      { role: 'system', content: '你是交付文档的审阅者。只输出 JSON：{"findings":[{"severity":"blocker|warn","message":"","evidence":"原文短引"}],"summary":""}。只基于给定文本；不判断未提供的内容；没有证据不要报；最多 8 条；没有明显问题返回空 findings。' },
      { role: 'user', content: `用户要求：${request || '(未提供)'}\n\n文档：\n${input}` },
    ],
  })
  return { ...parseDocReview(response.content), usage: response.usage }
}
