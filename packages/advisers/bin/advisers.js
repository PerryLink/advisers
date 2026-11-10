#!/usr/bin/env node
import { createAdvisers } from 'advisers-core'

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('usage: advisers <message>')
  process.exit(1)
}

const runtime = createAdvisers()
const context = await runtime.handleInbound({
  linkId: 'cli',
  accountId: 'local',
  conversationId: 'cli',
  messageId: `cli_${Date.now()}`,
  sender: { id: 'local' },
  text,
  timestamp: new Date().toISOString(),
})

console.log(context.prompt)
if (context.hints.length) {
  console.log('\nhints:')
  for (const hint of context.hints) console.log(`- ${hint.title}: ${hint.why}`)
}
