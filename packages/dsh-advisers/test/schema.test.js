import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

test('DSH bundle registers both tools with a host-valid schema', () => {
  const tools = []
  const ctx = { provide() {}, tools: { register(tool) { tools.push(tool) } } }
  apply(ctx, { workspace: process.cwd() })
  assert.equal(tools.length, 2)
  assert.deepEqual(tools.map((t) => t.name).sort(), ['advisers_brief', 'advisers_office'])
})
