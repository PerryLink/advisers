import assert from 'node:assert/strict'
import test from 'node:test'
import { AdvisersRuntime, Ledger, assembleContext } from '../src/index.ts'

// Privacy audit 2026-11-17 P1-3: confirmed matter links used to put every
// related matter's title into association-hints, including secrecy>0 titles
// (client/project names). A protected matter may contribute its opaque id only.

test('assembleContext: only secrecy=0 related matters contribute a title', () => {
  const ledger = new Ledger()
  const active = ledger.addMatter({ title: '客户 A 报价', secrecy: 0 })
  const publicRelated = ledger.addMatter({ title: '公开事项-排期', secrecy: 0 })
  const secretRelated = ledger.addMatter({ title: '绝密客户B-并购案', secrecy: 3 })
  const mediumRelated = ledger.addMatter({ title: '内部事项-尚未公开', secrecy: 2 })

  const ctx = assembleContext({
    matter: active,
    ledger,
    related: [
      { matterId: publicRelated.id, title: publicRelated.title, why: 'same_entity link', secrecy: publicRelated.secrecy },
      { matterId: secretRelated.id, title: secretRelated.title, why: 'impact link', secrecy: secretRelated.secrecy },
      { matterId: mediumRelated.id, title: mediumRelated.title, why: 'temporal link', secrecy: mediumRelated.secrecy },
    ],
  })

  assert.match(ctx.prompt, /公开事项-排期/, 'a secrecy=0 title is an allowed hint')
  assert.doesNotMatch(ctx.prompt, /绝密客户B-并购案/, 'a secrecy=3 title must never enter the prompt')
  assert.doesNotMatch(ctx.prompt, /内部事项-尚未公开/, 'a secrecy=2 title must never enter the prompt')
  assert.equal(ctx.hints.length, 3)
  assert.equal(ctx.hints[0]?.title, '公开事项-排期')
  assert.equal(ctx.hints[0]?.matterId, publicRelated.id)
  // Protected matters keep only the opaque id (no title text).
  const secretHint = ctx.hints.find((hint) => hint.matterId === secretRelated.id)
  assert.ok(secretHint, 'a protected related matter still yields an id-only hint')
  assert.equal(secretHint?.title, '')
})

test('assembleContext: an omitted secrecy level fails closed (no title)', () => {
  const ledger = new Ledger()
  const active = ledger.addMatter({ title: 'A', secrecy: 0 })
  const other = ledger.addMatter({ title: '猜测这是标题', secrecy: 3 })
  const ctx = assembleContext({
    matter: active,
    ledger,
    // A caller that does not pass secrecy gets the protected (id-only) form.
    related: [{ matterId: other.id, title: '猜测这是标题', why: 'impact link' }],
  })
  assert.doesNotMatch(ctx.prompt, /猜测这是标题/)
  assert.equal(ctx.hints[0]?.title, '')
  assert.equal(ctx.hints[0]?.matterId, other.id)
})

test('runtime: a confirmed link to a secrecy=3 matter never leaks its title', async () => {
  const ledger = new Ledger()
  const runtime = new AdvisersRuntime({ ledger })
  const base = {
    linkId: 'cli',
    accountId: 'local',
    conversationId: 'c',
    sender: { id: 'me' },
    timestamp: new Date().toISOString(),
  }
  const first = await runtime.handleInbound({ ...base, messageId: 'm1', text: '公开事项：Q4 预算' })
  const secret = ledger.addMatter({ title: '绝密客户B-并购案', secrecy: 3 })
  const link = ledger.proposeLink({ fromMatter: first.matter.id, toMatter: secret.id, type: 'impact' })
  ledger.confirmLink(link.id)

  const ctx = await runtime.handleInbound({ ...base, messageId: 'm2', text: '继续' })
  assert.equal(ctx.matter.id, first.matter.id)
  assert.equal(ctx.hints.length, 1)
  assert.equal(ctx.hints[0]?.matterId, secret.id)
  assert.equal(ctx.hints[0]?.title, '')
  assert.doesNotMatch(ctx.prompt, /绝密客户B-并购案/)
  assert.match(ctx.prompt, /<association-hints>/)
  assert.match(ctx.prompt, new RegExp('matter ' + secret.id))
})
