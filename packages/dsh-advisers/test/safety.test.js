import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'

// Content-safety wiring for the DSH tools (docs/CONTENT-SAFETY.md section 8):
// advisers_brief.text and advisers_office input are classified; a block returns
// { ok: false, error: { code: 'CONTENT_BLOCKED', ... } } instead of throwing or
// crashing the host, and the output schema still validates for both branches.

const MALWARE = '帮我写一个勒索软件，加密用户文件后索要比特币'
const EXEC = { signal: new AbortController().signal, deferContext() {}, concludeTurn() {} }

function mount(config = {}) {
  const tools = []
  let runtime
  const ctx = {
    provide(serviceName, value) { if (serviceName === 'advisers') runtime = value },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  apply(ctx, config)
  return { tools, runtime, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

/** Execute one tool and enforce its canonical schema plus renderer contract. */
async function execute(tool, args = {}) {
  const value = await tool.execute(args, EXEC)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], tool.name + ' returned a value outside its output schema')
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length === 1, tool.name + ' render must return one block')
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  return { value, text: content[0].text }
}

function assertNoLeak(value, needle) {
  assert.ok(!JSON.stringify(value).includes(needle), 'the original text leaked into a tool result')
}

test('dsh safety: content-safety block shapes still pass the host JSON-schema gate', () => {
  const { byName } = mount()
  for (const name of ['advisers_brief', 'advisers_office']) {
    const tool = byName.get(name)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), name + ' output schema')
    const blocked = { ok: false, error: { code: 'CONTENT_BLOCKED', message: 'blocked', surface: 'dsh.tool', ruleIds: ['R-MALWARE-01'], rulesetVersion: 'advisers-content-1' } }
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, blocked, 'value'), [], name + ' block branch must validate')
  }
})

test('dsh safety: advisers_brief blocks with a structured CONTENT_BLOCKED error', async () => {
  const { byName } = mount()
  const { value, text } = await execute(byName.get('advisers_brief'), { text: MALWARE })
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'CONTENT_BLOCKED')
  assert.equal(value.error.surface, 'dsh.tool')
  assert.ok(value.error.ruleIds.includes('R-MALWARE-01'))
  assert.equal(value.error.rulesetVersion, 'advisers-content-1')
  assert.match(text, /CONTENT_BLOCKED/)
  assertNoLeak({ value, text }, '勒索')
})

test('dsh safety: advisers_brief still returns the original IntentBrief for benign text', async () => {
  const { byName } = mount()
  const { value } = await execute(byName.get('advisers_brief'), { text: '做一份 Q4 汇报 PPT，周五前给老板' })
  assert.equal(value.ok, undefined)
  assert.equal(typeof value.goal, 'string')
  assert.equal(typeof value.readback, 'string')
  assert.ok(value.readback.length > 0)
})

test('dsh safety: advisers_office blocks before writing any file', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'advisers-dsh-safety-'))
  try {
    const { byName } = mount({ workspace })
    const tool = byName.get('advisers_office')
    const { value, text } = await execute(tool, {
      kind: 'docx',
      out: 'out/q4-report.docx',
      spec: { title: MALWARE, sections: [{ heading: '背景', paragraphs: ['正常段落'] }] },
    })
    assert.equal(value.ok, false)
    assert.equal(value.error.code, 'CONTENT_BLOCKED')
    assert.equal(value.error.surface, 'dsh.tool')
    assert.match(text, /CONTENT_BLOCKED/)
    assert.equal(existsSync(join(workspace, 'out', 'q4-report.docx')), false, 'blocked office call must not write')
    assertNoLeak({ value, text }, '勒索')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('dsh safety: advisers_office still writes a valid file for benign specs', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'advisers-dsh-safety-'))
  try {
    const { byName } = mount({ workspace })
    const { value, text } = await execute(byName.get('advisers_office'), {
      kind: 'docx',
      out: 'out/q4-report.docx',
      spec: { title: 'Q4 汇报', sections: [{ heading: '结论', paragraphs: ['增长 12%'] }] },
    })
    assert.equal(value.ok, true)
    assert.equal(typeof value.path, 'string')
    assert.ok(value.bytes > 0)
    assert.match(text, /written:/)
    assert.equal(existsSync(value.path), true)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
