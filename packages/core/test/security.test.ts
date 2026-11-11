import assert from 'node:assert/strict'
import test from 'node:test'
import { AdvisersRuntime, Ledger } from '../src/index.ts'

test('50-matter association hints never inject other matter bodies', async () => {
  const ledger = new Ledger()
  const runtime = new AdvisersRuntime({ ledger })
  const base = { linkId: 'cli', accountId: 'local', conversationId: 'c', sender: { id: 'me' }, timestamp: new Date().toISOString() }
  const first = await runtime.handleInbound({ ...base, messageId: 'm1', text: '主事项：Q4 预算' })
  for (let i = 0; i < 50; i++) {
    const other = ledger.addMatter({ title: `关联事项 ${i}`, summary: `SECRET_${i}` })
    if (i < 25) {
      const link = ledger.proposeLink({ fromMatter: first.matter.id, toMatter: other.id, type: 'impact' })
      ledger.confirmLink(link.id)
    }
  }
  const ctx = await runtime.handleInbound({ ...base, messageId: 'm2', text: '继续' })
  assert.equal(ctx.hints.length, 3)
  for (let i = 0; i < 50; i++) assert.doesNotMatch(ctx.prompt, new RegExp(`SECRET_${i}`))
})
