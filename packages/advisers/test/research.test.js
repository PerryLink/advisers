import assert from 'node:assert/strict'
import test from 'node:test'
import { research } from '../lib/research.js'

test('research parses server search results and citations', async () => {
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    assert.match(url, /\/anthropic\/v1\/messages$/)
    return new Response(JSON.stringify({
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 's1', name: 'deepseek_web_search', input: { action: 'search', queries: ['q'] }, kind: 'search' },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'T', url: 'https://example.com/a', page_age: '2026-01-01T00:00:00Z', snippet: 'S' }], kind: 'search' },
        { type: 'text', text: '答案', citations: [{ type: 'web_search_result_location', url: 'https://example.com/a', title: 'T', cited_text: '答案' }] },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    }), { status: 200 })
  }
  const result = await research({ query: 'q', apiKey: 'k', fetchImpl })
  assert.equal(result.answer, '答案')
  assert.equal(result.sources[0].url, 'https://example.com/a')
  assert.equal(result.citations[0].citedText, '答案')
  assert.equal(body.tools[0].type, 'deepseek_web_search')
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('research with a URL uses read_url only', async () => {
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
  }
  await research({ query: '总结', urls: ['https://example.com'], apiKey: 'k', fetchImpl })
  assert.equal(body.tools[0].type, 'deepseek_read_url')
  assert.match(body.messages[0].content, /example\.com/)
})
