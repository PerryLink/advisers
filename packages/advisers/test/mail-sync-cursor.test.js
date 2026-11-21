import assert from 'node:assert/strict'
import test from 'node:test'
import { mailSync } from '../lib/mail.js'
import { addTestAccount, makeEml, openMailStore, startMockImap } from './mail-fixture.js'

const NOW = new Date('2026-11-20T02:00:00.000Z')

function cursorOf(store, accountId) {
  return store.db.prepare('SELECT * FROM mail_cursors WHERE account_id = ?').get(accountId)
}

test('mail sync: --limit fetches oldest-first batches and the next sync continues from the cursor', async () => {
  const mock = await startMockImap({
    uidvalidity: '10',
    messages: [
      makeEml({ messageId: '<b1@example.com>', subject: '一' }),
      makeEml({ messageId: '<b2@example.com>', subject: '二' }),
      makeEml({ messageId: '<b3@example.com>', subject: '三' }),
    ],
  })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const first = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, limit: 2, now: NOW })
    assert.equal(first.fetched, 2)
    assert.equal(first.inserted, 2)
    assert.equal(cursorOf(space.store, account.id).last_uid, 2)
    const second = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: NOW })
    assert.equal(second.fetched, 1)
    assert.equal(second.inserted, 1)
    assert.equal(cursorOf(space.store, account.id).last_uid, 3)
    assert.equal(Number(space.store.db.prepare('SELECT last_uid_after FROM mail_sync_runs ORDER BY started_at ASC LIMIT 1').get().last_uid_after), 2)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: a failed message never advances the cursor past it, and the next sync repairs the gap', async () => {
  const mock = await startMockImap({
    messages: [
      makeEml({ messageId: '<f1@example.com>' }),
      makeEml({ messageId: '<f2@example.com>' }),
      makeEml({ messageId: '<f3@example.com>' }),
    ],
  })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    mock.state.failUids.add(2)
    const first = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: NOW })
    assert.equal(first.inserted, 2)
    assert.equal(first.failed, 1)
    assert.equal(cursorOf(space.store, account.id).last_uid, 1, 'cursor stops before the failed UID 2')
    const run = space.store.db.prepare('SELECT failed FROM mail_sync_runs ORDER BY started_at ASC LIMIT 1').get()
    assert.equal(Number(run.failed), 1)
    mock.state.failUids.delete(2)
    const second = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: NOW })
    assert.equal(second.inserted, 1)
    assert.equal(second.skipped, 1, 'UID 3 was already stored and is deduped')
    assert.equal(cursorOf(space.store, account.id).last_uid, 3)
    assert.equal(Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n), 3)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: an empty first sync records a null cursor and the next run safely searches SINCE again', async () => {
  const mock = await startMockImap({ uidvalidity: '1', messages: [] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const first = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: NOW })
    assert.equal(first.fetched, 0)
    assert.equal(first.inserted, 0)
    const cursor = cursorOf(space.store, account.id)
    assert.ok(cursor)
    assert.equal(cursor.last_uid, null)
    assert.equal(cursor.uidvalidity, '1')
    const mark = mock.commands.length
    const second = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: NOW })
    assert.equal(second.inserted, 0)
    const commands = mock.commands.slice(mark)
    assert.ok(commands.some((command) => /UID SEARCH SINCE\b/i.test(command)), 'a null cursor falls back to the SINCE scan: ' + commands.join(' | '))
  } finally {
    await mock.close()
    space.cleanup()
  }
})
