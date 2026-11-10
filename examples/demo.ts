import { createAdvisers } from '../packages/core/src/index.ts'

const runtime = createAdvisers()
const ctx = await runtime.handleInbound({
  linkId: 'email',
  accountId: 'me@example.com',
  conversationId: 'thread-42',
  messageId: 'msg-1',
  sender: { id: 'me@example.com', name: 'Me' },
  text: '周五前把报价 PDF 发给王工，另外他说预算可能砍 10%。',
  timestamp: new Date().toISOString(),
})

console.log(ctx.prompt)
console.log('\nhints:', ctx.hints)
console.log('tokens:', ctx.usedTokens)
