import assert from 'node:assert/strict'
import test from 'node:test'
import { EmailLink } from '../src/index.ts'
import { buildRawEmail, mapParsed } from '../src/imap.ts'

test('buildRawEmail is UTF-8 MIME and has no SMTP dependency', () => {
  const raw = buildRawEmail({ to: 'boss@example.com', subject: 'Q4 预算', body: '结论：可控' }, 'me@example.com')
  const text = raw.toString('utf8')
  assert.match(text, /^From: me@example.com/m)
  assert.match(text, /Subject: =\?UTF-8\?B\?/)
  assert.match(text, /Content-Transfer-Encoding: base64/)
  const body = Buffer.from(text.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8')
  assert.equal(body, '结论：可控')
})

test('mapParsed maps IMAP fields and thread references', () => {
  const message = mapParsed({
    messageId: '<m1@example.com>',
    subject: 'Re: 报价',
    text: '请周五前发',
    from: { value: [{ address: 'boss@example.com', name: 'Boss' }] },
    references: ['<root@example.com>'],
  })
  assert.equal(message.from, 'boss@example.com')
  assert.equal(message.fromName, 'Boss')
  assert.equal(message.subject, 'Re: 报价')
  assert.equal(message.threadId, '<root@example.com>')
})

test('EmailLink starts a source and creates drafts, never sends', async () => {
  let callback: ((message: any) => Promise<void>) | undefined
  let stopped = false
  const drafts: any[] = []
  const source = {
    async start(cb: (message: any) => Promise<void>) { callback = cb },
    async stop() { stopped = true },
  }
  const transport = {
    async send() { throw new Error('send must not be called') },
    async draft(input: any) { drafts.push(input); return { id: 'draft-1' } },
  }
  const link = new EmailLink(transport, 'me@example.com', { source })
  await link.start({ async ingest() { return { accepted: true } }, async resolvePrincipal() { return 'p' } })
  await callback?.(({ from: 'boss@example.com', subject: 'x', body: 'y', messageId: 'm' }))
  const result = await link.send({ conversationId: 'boss@example.com', text: 'hi' })
  assert.equal(result.ok, true)
  assert.equal(drafts.length, 1)
  await link.stop()
  assert.equal(stopped, true)
})
