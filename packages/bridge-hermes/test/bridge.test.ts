import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HermesBridgeLink } from '../src/index.ts'

test('consumes Hermes inbox JSON and writes an outbox reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-hermes-bridge-'))
  const events: any[] = []
  const link = new HermesBridgeLink({ bridgeDir: dir, name: 'advisers', pollMs: 60_000 })
  try {
    await link.start({ async ingest(e) { events.push(e); return { accepted: true } }, async resolvePrincipal() { return 'p' } })
    assert.equal(existsSync(join(dir, 'registry', 'advisers.yaml')), true)
    writeFileSync(join(dir, 'inbox', 'advisers', 'in_1.json'), JSON.stringify({
      bridge: 'advisers', id: 'msg_1', sender: 'ou_1', sender_name: 'Boss', text: '周五前给报价',
      chat: { id: 'oc_1', type: 'group', thread_id: 'th_1' }, timestamp: '2026-11-11T00:00:00Z',
    }))
    await link.pollOnce()
    assert.equal(events.length, 1)
    assert.equal(events[0].conversationId, 'oc_1')
    assert.equal(events[0].text, '周五前给报价')
    assert.equal(events[0].dedupeKey, 'msg_1')
    assert.equal(existsSync(join(dir, 'inbox', 'advisers', 'in_1.json')), false)

    const delivered = await link.send({ conversationId: 'oc_1', text: '收到', threadId: 'th_1', idempotencyKey: 'k1' })
    assert.equal(delivered.ok, true)
    const out = JSON.parse(readFileSync(join(dir, 'outbox', 'advisers', `${delivered.messageId}.json`), 'utf8'))
    assert.equal(out.target, 'advisers~oc_1')
    assert.equal(out.text, '收到')
    assert.equal(out.thread_id, 'th_1')
  } finally {
    await link.stop()
    assert.equal(existsSync(join(dir, 'registry', 'advisers.yaml')), false)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leaves malformed inbox files for a retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-hermes-bridge-'))
  const link = new HermesBridgeLink({ bridgeDir: dir, pollMs: 60_000 })
  try {
    await link.start({ async ingest() { return { accepted: true } }, async resolvePrincipal() { return 'p' } })
    writeFileSync(join(dir, 'inbox', 'advisers', 'bad.json'), '{not json')
    await link.pollOnce()
    assert.equal(existsSync(join(dir, 'inbox', 'advisers', 'bad.json')), true)
  } finally {
    await link.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
