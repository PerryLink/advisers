/**
 * 0.5.1 (plan 92 section 4): mail_messages thread_root / direction /
 * auto_submitted storage.
 *
 * The store derives all three values at build time from the parsed headers and
 * the account username; the INSERT quotes the SQLite keyword "references".
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAIL_MAX_THREAD_REFERENCES,
  buildMailMessageRow,
  computeMailDirection,
  computeMailThreadRoot,
  getMailMessage,
  insertMailMessage,
  listMailMessages,
  normalizeMailReferences,
} from '../lib/mail-store.js'
import { openMailStore } from './mail-fixture.js'

const NOW = new Date('2026-11-20T02:00:00.000Z')

function insertRow(space, overrides = {}) {
  const row = buildMailMessageRow({
    accountId: 'acct_1',
    mailbox: 'INBOX',
    uid: overrides.uid ?? 1,
    uidvalidity: '7',
    receivedAt: NOW.toISOString(),
    from: '王工 <wang@acme.cn>',
    subject: '报价',
    messageId: '<m@x.y>',
    text: '我周五前把报价发给你。',
    accountUsername: 'me@example.com',
    now: NOW,
    ...overrides,
  })
  space.store.mutate((store) => { insertMailMessage(store, row) })
  return row
}

test('threadRoot = references[0] ?? inReplyTo ?? messageId', () => {
  assert.equal(computeMailThreadRoot({ messageId: 'm@x.y' }), 'm@x.y')
  assert.equal(computeMailThreadRoot({ messageId: 'm@x.y', inReplyTo: 'p@x.y' }), 'p@x.y')
  assert.equal(computeMailThreadRoot({ messageId: 'm@x.y', inReplyTo: 'p@x.y', references: ['r@x.y', 'p@x.y'] }), 'r@x.y')
  assert.equal(computeMailThreadRoot({ messageId: null, inReplyTo: null, references: [] }), null)
})

test('direction: inbound, outbound by matching username, outbound by Sent mailbox, unknown for local import', () => {
  assert.equal(computeMailDirection({ from: '王工 <wang@acme.cn>', username: 'me@example.com', mailbox: 'INBOX' }), 'inbound')
  assert.equal(computeMailDirection({ from: 'Me <ME@Example.com>', username: 'me@example.com', mailbox: 'INBOX' }), 'outbound')
  assert.equal(computeMailDirection({ from: 'me@example.com', username: 'me@example.com', mailbox: 'INBOX' }), 'outbound')
  for (const mailbox of ['Sent', 'Sent Items', '已发送', '已发送邮件']) {
    assert.equal(computeMailDirection({ from: '王工 <wang@acme.cn>', username: 'me@example.com', mailbox }), 'outbound', mailbox)
  }
  assert.equal(computeMailDirection({ from: '王工 <wang@acme.cn>', username: '(local)', mailbox: 'local' }), 'unknown')
  assert.equal(computeMailDirection({ from: '', username: 'me@example.com', mailbox: 'INBOX' }), 'unknown')
})

test('buildMailMessageRow derives all new columns', () => {
  const row = buildMailMessageRow({
    accountId: 'acct_1',
    mailbox: 'INBOX',
    uid: 1,
    receivedAt: NOW.toISOString(),
    from: '王工 <wang@acme.cn>',
    subject: 'Re: 报价',
    messageId: '<reply-2@acme.cn>',
    references: ['<root-0@example.com>', ' <orig-1@example.com> '],
    inReplyTo: '<orig-1@example.com>',
    autoSubmitted: ' Auto-Replied ',
    accountUsername: 'me@example.com',
    now: NOW,
  })
  assert.deepEqual(row.references, ['root-0@example.com', 'orig-1@example.com'])
  assert.equal(row.inReplyTo, 'orig-1@example.com')
  assert.equal(row.threadRoot, 'root-0@example.com')
  assert.equal(row.direction, 'inbound')
  assert.equal(row.autoSubmitted, 'auto-replied')
  assert.equal(row.messageId, 'reply-2@acme.cn', 'message id keeps its unbracketed form')
})

test('references are bounded at the store boundary too', () => {
  const many = Array.from({ length: MAIL_MAX_THREAD_REFERENCES + 10 }, (_, index) => 'r' + index + '@x.y')
  assert.equal(normalizeMailReferences(many).length, MAIL_MAX_THREAD_REFERENCES)
  assert.deepEqual(normalizeMailReferences(['<a@x.y>', 'a@x.y', 'b@x.y']), ['a@x.y', 'b@x.y'])
  assert.deepEqual(normalizeMailReferences('not-an-array'), [])
})

test('insert/get/list round-trip the new columns (quoted "references" column)', () => {
  const space = openMailStore()
  try {
    const row = insertRow(space, {
      messageId: '<reply-2@acme.cn>',
      inReplyTo: 'orig-1@example.com',
      references: ['root-0@example.com', 'orig-1@example.com'],
      autoSubmitted: 'auto-generated',
    })
    const got = getMailMessage(space.store, row.id)
    assert.equal(got.inReplyTo, 'orig-1@example.com')
    assert.deepEqual(got.references, ['root-0@example.com', 'orig-1@example.com'])
    assert.equal(got.threadRoot, 'root-0@example.com')
    assert.equal(got.direction, 'inbound')
    assert.equal(got.autoSubmitted, 'auto-generated')
    const listed = listMailMessages(space.store, {})
    assert.equal(listed.messages[0].threadRoot, 'root-0@example.com')
    assert.equal(listed.messages[0].direction, 'inbound')
    assert.deepEqual(space.store.db.prepare('SELECT "references" FROM mail_messages').get().references, '["root-0@example.com","orig-1@example.com"]')
    assert.equal(Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE thread_root = ?').get('root-0@example.com').n), 1)
    const indexes = space.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mail_thread'").all()
    assert.equal(indexes.length, 1, 'v23 creates idx_mail_thread(account_id, thread_root)')
  } finally { space.cleanup() }
})

test('legacy row with NULL threading columns maps to unknown direction and no thread root', () => {
  const space = openMailStore()
  try {
    space.store.mutate(() => {
      space.store.db.prepare(
        'INSERT INTO mail_messages(id,account_id,mailbox,uid,uidvalidity,message_id,dedupe_key,from_addr,subject,received_at,attachments,status,candidate_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run('msg_legacy', 'acct_1', 'INBOX', 9, '7', 'old@x.y', 'legacy-key', '王工 <wang@acme.cn>', '旧邮件', NOW.toISOString(), '[]', 'new', '[]', NOW.toISOString(), NOW.toISOString())
    })
    const got = getMailMessage(space.store, 'msg_legacy')
    assert.equal(got.threadRoot, undefined)
    assert.deepEqual(got.references, [])
    assert.equal(got.inReplyTo, undefined)
    assert.equal(got.direction, 'unknown', 'migration default: never guessed')
    assert.equal(got.autoSubmitted, undefined)
  } finally { space.cleanup() }
})
