import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeTool, runAgent } from '../lib/agent.js'

function fakeFetch(responses) {
  let i = 0
  return async () => new Response(JSON.stringify(responses[i++]), { status: 200 })
}

test('agent executes an office tool and returns the final reply', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    const fetchImpl = fakeFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'office_build', arguments: JSON.stringify({ kind: 'docx', out: 'out/report.docx', spec: { title: 'Q4 汇报', sections: [{ heading: '结论', paragraphs: ['增长 12%'] }] } }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: '已生成 out/report.docx' } }] },
    ])
    const result = await runAgent({
      runtime: {},
      text: '做一份 Q4 汇报 Word',
      context: { prompt: '<advisers-context/>' },
      apiKey: 'test',
      cwd,
      fetchImpl,
    })
    assert.equal(result.reply, '已生成 out/report.docx')
    assert.equal(result.artifacts.length, 1)
    assert.equal(existsSync(join(cwd, 'out/report.docx')), true)
    assert.equal(result.toolLog[0].name, 'office_build')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('file tools are scoped to the workspace', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    assert.equal((await executeTool('file_write', { path: 'a.txt', content: 'hello' }, { cwd })).ok, true)
    assert.equal((await executeTool('file_read', { path: 'a.txt' }, { cwd })).content, 'hello')
    await assert.rejects(() => executeTool('file_read', { path: '../outside' }, { cwd }), /escapes workspace/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent surfaces a tool error back to the model instead of crashing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    const calls = []
    const fetchImpl = async (_url, init) => {
      calls.push(JSON.parse(init.body))
      if (calls.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: '../secret' }) } }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '读取失败，已报告。' } }] }), { status: 200 })
    }
    const result = await runAgent({ text: '读文件', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl })
    assert.match(result.reply, /读取失败/)
    assert.equal(result.toolLog[0].ok, false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent asks before overwriting an existing file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    writeFileSync(join(cwd, 'a.txt'), 'old')
    const fetchImpl = fakeFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ path: 'a.txt', content: 'new' }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'done' } }] },
    ])
    const result = await runAgent({ text: '写 a.txt', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl, confirm: async () => false })
    assert.equal(result.declined, true)
    assert.match(result.reply, /未覆盖/)
    assert.equal((await executeTool('file_read', { path: 'a.txt' }, { cwd })).content, 'old')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent writes after overwrite confirmation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    writeFileSync(join(cwd, 'a.txt'), 'old')
    const fetchImpl = fakeFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ path: 'a.txt', content: 'new' }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'done' } }] },
    ])
    await runAgent({ text: '写 a.txt', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl, confirm: async () => true })
    assert.equal((await executeTool('file_read', { path: 'a.txt' }, { cwd })).content, 'new')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
