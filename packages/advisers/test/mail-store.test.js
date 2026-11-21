import assert from 'node:assert/strict'
import test from 'node:test'
import { mailAccountAdd, mailAccountList } from '../lib/mail.js'
import {
  MAIL_MAX_BODY_BYTES, buildMailMessageRow, mailDedupeKey, mailMessageRowId,
} from '../lib/mail-store.js'
import { openMailStore } from './mail-fixture.js'

const NOW = new Date('2026-11-20T02:00:00.000Z')

test('a ledger without the v22 mail tables fails closed with E_SCHEMA_STALE', () => {
  const space = openMailStore()
  try {
    space.store.db.exec('DROP TABLE mail_messages; DROP TABLE mail_cursors; DROP TABLE mail_accounts; DROP TABLE mail_sync_runs')
    assert.throws(() => mailAccountList(space.store, { home: space.home }), (error) => error.code === 'E_SCHEMA_STALE')
  } finally { space.cleanup() }
})

test('account config defaults: implicit TLS on 993, STARTTLS on 143, retention 30 days', () => {
  const space = openMailStore()
  try {
    const implicit = mailAccountAdd(space.store, { name: 'implicit', host: 'imap.example.com', username: 'u@example.com' }, { home: space.home, now: new Date(NOW.getTime()) }).account
    assert.equal(implicit.tls, 'tls')
    assert.equal(implicit.port, 993)
    assert.equal(implicit.mailbox, 'INBOX')
    assert.equal(implicit.retentionDays, 30)
    assert.equal(implicit.status, 'active')
    assert.equal(implicit.createdAt, NOW.toISOString())
    const starttls = mailAccountAdd(space.store, { name: 'starttls', host: 'imap.example.com', username: 'u@example.com', port: 143 }, { home: space.home, now: new Date(NOW.getTime() + 1000) }).account
    assert.equal(starttls.tls, 'starttls')
    assert.equal(starttls.port, 143)
    const explicit = mailAccountAdd(space.store, { name: 'custom', host: 'imap.example.com', username: 'u@example.com', tls: 'starttls', port: 1430, retentionDays: 0 }, { home: space.home, now: new Date(NOW.getTime() + 2000) }).account
    assert.equal(explicit.port, 1430)
    assert.equal(explicit.retentionDays, 0)
    assert.deepEqual(mailAccountList(space.store, { home: space.home }).accounts.map((account) => account.name), ['implicit', 'starttls', 'custom'])
  } finally { space.cleanup() }
})

test('dedupe key: Message-ID wins over UID; UID key is stable; .eml content key is deterministic', () => {
  const messageId = 'abc@example.com'
  assert.equal(
    mailDedupeKey({ accountId: 'acct_1', mailbox: 'INBOX', uidvalidity: '7', uid: 1, messageId: '<' + messageId + '>' }),
    mailDedupeKey({ accountId: 'acct_1', mailbox: 'INBOX', uidvalidity: '9', uid: 99, messageId: messageId }),
    'angle brackets and the UID are irrelevant when a Message-ID exists',
  )
  const noId = (uid, text = 'body') => mailDedupeKey({ accountId: 'acct_1', mailbox: 'INBOX', uidvalidity: '7', uid, text })
  assert.notEqual(noId(1), noId(2))
  assert.equal(noId(1), noId(1), 'stable for one message')
  const content = (text) => mailDedupeKey({ accountId: 'acct_1', mailbox: 'local', uidvalidity: 'local', uid: null, from: 'a@x', subject: 's', date: 'd', text })
  assert.equal(content('我周五前发报价'), content('我周五前发报价'), 'same .eml file content dedupes')
  assert.notEqual(content('我周五前发报价'), content('我周一前发合同'))
  const key = noId(5)
  assert.equal(mailMessageRowId('acct_1', key), mailMessageRowId('acct_1', key))
  assert.notEqual(mailMessageRowId('acct_1', key), mailMessageRowId('acct_2', key))
})

test('body is short-retained (256KiB cap + marker) and attachment metadata is bounded/sanitised', () => {
  const now = NOW.toISOString()
  const row = buildMailMessageRow({
    accountId: 'acct_1', mailbox: 'INBOX', uid: 1, uidvalidity: '7',
    receivedAt: now, sentAt: now, from: 'a@example.com', subject: 'S', messageId: '<m@x>',
    text: '中'.repeat(300_000),
    attachments: [
      { name: 'quote\u0000.pdf', size: 12.9, mime: 'application/pdf' },
      { name: '', size: 1, mime: '' },
      ...Array.from({ length: 60 }, (_, index) => ({ name: 'a' + index + '.bin', size: index, mime: 'application/octet-stream' })),
    ],
    now: NOW,
  })
  assert.ok(Buffer.byteLength(row.bodyText, 'utf8') <= MAIL_MAX_BODY_BYTES + 64)
  assert.match(row.bodyText, /\[body truncated by advisers\]$/)
  assert.match(row.bodySha256, /^[0-9a-f]{64}$/)
  assert.equal(row.status, 'new')
  assert.equal(row.attachments.length, 50)
  assert.equal(row.attachments[0].name, 'quote .pdf', 'control characters are stripped from metadata names')
  assert.equal(row.attachments[0].size, 12)
  assert.equal(row.attachments[0].mime, 'application/pdf')
  assert.equal(row.attachments[1].name, 'a0.bin')
  const empty = buildMailMessageRow({ accountId: 'acct_1', receivedAt: now, text: null, now: NOW })
  assert.equal(empty.bodyText, null)
  assert.equal(empty.status, 'metadata')
  assert.equal(empty.bodySha256, null)
})
