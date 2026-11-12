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

test('office templates reject empty required data', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    await assert.rejects(
      () => executeTool('office_template', { name: 'budget', out: 'b.xlsx', data: { rows: [] } }, { cwd }),
      /non-empty rows/,
    )
    const ok = await executeTool('office_template', {
      name: 'budget', out: 'b.xlsx', data: { rows: [{ item: '市场', amount: 120 }] },
    }, { cwd })
    assert.equal(ok.ok, true)
    assert.equal(existsSync(join(cwd, 'b.xlsx')), true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent receives persisted history and session summary', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    let body
    const fetchImpl = async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '接着上次改' } }] }), { status: 200 })
    }
    const result = await runAgent({
      text: '把预算改成 420',
      context: { prompt: '<advisers-context/>' },
      history: [
        { role: 'user', content: '做预算' },
        { role: 'assistant', content: '已生成 out/budget.xlsx' },
      ],
      summary: '用户要求先给结论',
      apiKey: 'k',
      cwd,
      fetchImpl,
    })
    assert.equal(result.reply, '接着上次改')
    assert.deepEqual(body.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user'])
    assert.match(body.messages[0].content, /session-summary/)
    assert.match(body.messages[0].content, /先给结论/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('routine_view is available from the routine index', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-agent-'))
  try {
    const ledger = { listRoutines: () => [{ id: 'routine_1', name: '周报流程', status: 'active', description: '周报', steps: ['office_template'] }] }
    const fetchImpl = fakeFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'routine_view', arguments: JSON.stringify({ id: 'routine_1' }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: '按周报流程做' } }] },
    ])
    const result = await runAgent({ text: '做周报', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl, ledger })
    assert.equal(result.reply, '按周报流程做')
    assert.equal(result.toolLog[0].ok, true)
    assert.equal(result.toolLog[0].payload.routine.name, '周报流程')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('path guard blocks protected files and symlink escapes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-path-'))
  const outside = mkdtempSync(join(tmpdir(), 'advisers-outside-'))
  try {
    await assert.rejects(() => executeTool('file_write', { path: '.git/hooks/post-checkout', content: 'x' }, { cwd }), /protected/)
    await assert.rejects(() => executeTool('file_write', { path: 'package.json', content: 'x' }, { cwd }), /protected/)
    await import('node:fs/promises').then((fs) => fs.symlink(outside, join(cwd, 'out')))
    await assert.rejects(() => executeTool('file_write', { path: 'out/pwn.txt', content: 'x' }, { cwd }), /symlink/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('commitment_add records evidence before a promise', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-cm-'))
  try {
    const { Ledger } = await import('../../core/dist/index.js')
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '客户' })
    const fetchImpl = fakeFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commitment_add', arguments: JSON.stringify({ action: '发报价', dueAt: '2026-11-13T10:00:00Z', creditor: '王工', quote: '周五前发报价给王工' }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: '记下了，周五前提醒你。' } }] },
    ])
    const result = await runAgent({ text: '周五前发报价给王工', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl, ledger, matterId: matter.id, turnId: 't1' })
    assert.equal(result.reply.includes('提醒'), true)
    assert.equal(ledger.openCommitments(matter.id).length, 1)
    assert.equal(ledger.openCommitments(matter.id)[0].evidence[0].quote, '周五前发报价给王工')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('memory_propose requires a verbatim quote and creates a pending candidate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-mem-'))
  try {
    const { Ledger } = await import('../../core/dist/index.js')
    const { SqliteStore } = await import('../lib/sqlite.js')
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '客户' })
    const store = new SqliteStore(':memory:')
    const fetchImpl = fakeFetch([
      { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'm1', type: 'function', function: { name: 'memory_propose', arguments: JSON.stringify({ kind: 'fact', quote: '我的时区是 Asia/Shanghai', predicate: 'timezone', object: 'Asia/Shanghai' }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: '待确认。' } }] },
    ])
    await runAgent({ text: '我的时区是 Asia/Shanghai', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl, ledger, store, matterId: matter.id, turnId: 't1' })
    assert.equal(store.listCandidates('pending').length, 1)
    assert.match(store.listCandidates('pending')[0].payload.object, /Shanghai/)
    const bad = await runAgent({ text: '别的话', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl: fakeFetch([{ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'm2', type: 'function', function: { name: 'memory_propose', arguments: JSON.stringify({ kind: 'fact', quote: '我的时区是 Asia/Shanghai', predicate: 'timezone', object: 'x' }) } }] } }] }, { choices: [{ message: { role: 'assistant', content: '未记录。' } }] }]), ledger, store, matterId: matter.id, turnId: 't2' })
    assert.equal(bad.toolLog[0].ok, false)
    assert.match(bad.toolLog[0].payload.error, /verbatim/)
    store.close()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('office_template builds Chinese minutes and notice through the agent tool', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'advisers-tpl-'))
  try {
    const cases = [
      { name: 'minutes', data: { date: '2026-11-12', agenda: ['报价'], actions: [{ what: '发报价', owner: '王工', due: '周五' }] }, out: 'out/m.docx' },
      { name: 'notice', data: { title: '通知', issuer: '公司', recipients: ['全员'], body: ['放假'], signer: '行政', date: '2026年11月12日' }, out: 'out/n.docx' },
    ]
    for (const c of cases) {
      const fetchImpl = fakeFetch([
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'office_template', arguments: JSON.stringify(c) } }] } }] },
        { choices: [{ message: { role: 'assistant', content: 'done' } }] },
      ])
      const result = await runAgent({ text: 'x', context: { prompt: '' }, apiKey: 'k', cwd, fetchImpl })
      assert.equal(result.toolLog[0].ok, true)
      assert.equal(existsSync(join(cwd, c.out)), true)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
