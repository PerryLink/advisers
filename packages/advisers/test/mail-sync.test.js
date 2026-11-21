import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import test from 'node:test'
import { removeImapCredential } from '../lib/credentials.js'
import { openMailImapSession } from '../lib/mail-imap.js'
import { mailAccountList, mailList, mailShow, mailSync } from '../lib/mail.js'
import { addTestAccount, makeEml, makeEmlWithAttachment, openMailStore, startMockImap } from './mail-fixture.js'

const HOUR_NOW = new Date('2026-11-20T02:00:00.000Z')

function count(store, table, where = '', params = []) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table + (where ? ' WHERE ' + where : '')).get(...params).n)
}

function cursorOf(store, accountId, mailbox = 'INBOX') {
  return store.db.prepare('SELECT * FROM mail_cursors WHERE account_id = ? AND mailbox = ?').get(accountId, mailbox)
}

test('mail sync: TLS-only session fetches a batch, writes messages+cursor+run+audit in one transaction', async () => {
  const mock = await startMockImap({
    uidvalidity: '777',
    messages: [
      makeEml({ messageId: '<a@example.com>', subject: '报价 A', body: '我周五前把报价发给你。' }),
      makeEml({ messageId: '<b@example.com>', subject: '报价 B', body: '我周一前把合同发给你。', date: 'Fri, 13 Nov 2026 09:00:00 +0800' }),
    ],
  })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const result = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, sinceDays: 30, now: HOUR_NOW })
    assert.equal(result.ok, true)
    assert.equal(result.command, 'mail sync')
    assert.equal(result.accountId, account.id)
    assert.equal(result.mailbox, 'INBOX')
    assert.equal(result.uidValidity, '777')
    assert.equal(result.fetched, 2)
    assert.equal(result.inserted, 2)
    assert.equal(result.skipped, 0)
    assert.equal(result.failed, 0)
    assert.equal(result.needsResync, false)
    assert.equal(result.dryRun, false)
    assert.equal(count(space.store, 'mail_messages'), 2)
    const cursor = cursorOf(space.store, account.id)
    assert.equal(cursor.uidvalidity, '777')
    assert.equal(cursor.last_uid, 2)
    assert.equal(cursor.status, 'ok')
    assert.equal(count(space.store, 'mail_sync_runs'), 1)
    const run = space.store.db.prepare('SELECT * FROM mail_sync_runs').get()
    assert.equal(Number(run.inserted), 2)
    assert.equal(run.uidvalidity, '777')
    assert.equal(Number(run.last_uid_after), 2)
    assert.equal(Number(space.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'mail.sync'").get().n), 1)
    const listed = mailList(space.store, {})
    assert.equal(listed.total, 2)
    assert.equal(listed.messages[0].subject, '报价 B')
    assert.equal(listed.messages[0].retained, true)
    const shown = mailShow(space.store, listed.messages[1].id)
    assert.equal('bodyText' in shown.message, false, 'mail show hides the body unless --body is explicit')
    const withBody = mailShow(space.store, listed.messages[1].id, { body: true })
    assert.match(withBody.message.bodyText, /我周五前把报价发给你/)
    // Read-only allowlist: no write command ever reached the server.
    for (const command of mock.commands) {
      assert.match(command, /^A\d+ (CAPABILITY|LOGIN|EXAMINE|UID SEARCH|UID FETCH|LOGOUT)\b/i, 'unexpected IMAP command: ' + command)
    }
    assert.ok(!mock.commands.some((command) => /^A\d+ (SELECT|STORE|APPEND|EXPUNGE|COPY|MOVE|DELETE)\b/i.test(command)))
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: the session command log redacts LOGIN and the password never appears', async () => {
  const mock = await startMockImap({ messages: [makeEml({ messageId: '<redact@example.com>' })] })
  const session = await openMailImapSession({
    host: '127.0.0.1', port: mock.port, tls: 'tls',
    user: 'me@example.com', pass: 'app-password-secret', connect: mock.connect,
  })
  try {
    assert.ok(session.commands.includes('LOGIN [redacted]'))
    assert.equal(session.commands.join(' ').includes('app-password-secret'), false)
    const box = await session.examine('INBOX')
    assert.equal(box.uidValidity, '100')
    assert.equal(box.exists, 1)
    const uids = await session.searchSince(30)
    assert.deepEqual(uids, [1])
  } finally {
    await session.logout()
    await mock.close()
  }
})

test('mail sync: second sync only searches after the cursor and a new UID is fetched', async () => {
  const mock = await startMockImap({ uidvalidity: '42', messages: [makeEml({ messageId: '<one@example.com>' })] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const first = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    assert.equal(first.inserted, 1)
    const mark = mock.commands.length
    const second = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    assert.equal(second.inserted, 0)
    assert.equal(second.fetched, 0)
    const incremental = mock.commands.slice(mark)
    assert.ok(incremental.some((command) => /UID SEARCH UID 2:\*/i.test(command)), 'must search from last_uid + 1: ' + incremental.join(' | '))
    assert.equal(incremental.some((command) => /UID FETCH 1(,|\b)/i.test(command)), false, 'must not refetch old UIDs')
    mock.state.messages.push({ uid: 2, raw: Buffer.from(makeEml({ messageId: '<two@example.com>', subject: '新邮件' }), 'utf8') })
    const third = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    assert.equal(third.inserted, 1)
    assert.equal(third.fetched, 1)
    const cursor = cursorOf(space.store, account.id)
    assert.equal(cursor.last_uid, 2)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: --full rescans without duplicates and keeps Message-ID dedupe across body changes', async () => {
  const mock = await startMockImap({
    uidvalidity: '55',
    messages: [makeEml({ messageId: '<same@example.com>', body: '我周五前发报价。' }), makeEml({ messageId: '<other@example.com>' })],
  })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    // Same Message-ID, different body: still one row; no TTL-based re-import.
    mock.state.messages[0].raw = Buffer.from(makeEml({ messageId: '<same@example.com>', body: '完全不同的正文，我下周发。' }), 'utf8')
    const full = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, full: true, now: HOUR_NOW })
    assert.equal(full.inserted, 0)
    assert.equal(full.skipped, 2)
    assert.equal(full.duplicates, 2)
    assert.equal(count(space.store, 'mail_messages'), 2)
    assert.match(mailShow(space.store, '<same@example.com>', { body: true }).message.bodyText, /我周五前发报价/)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: a UIDVALIDITY change needs --full, deletes nothing and never reuses the old UID cursor', async () => {
  const mock = await startMockImap({ uidvalidity: '100', messages: [makeEml({ messageId: '<u1@example.com>' }), makeEml({ messageId: '<u2@example.com>' })] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    mock.state.uidvalidity = '200'
    await assert.rejects(
      mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW }),
      (error) => error.code === 'E_IMAP_UIDVALIDITY',
    )
    assert.equal(count(space.store, 'mail_messages'), 2, 'UIDVALIDITY change must not delete local rows')
    const cursor = cursorOf(space.store, account.id)
    assert.equal(cursor.status, 'needs_resync')
    assert.equal(cursor.uidvalidity, '200')
    assert.equal(cursor.last_uid, null)
    assert.equal(space.store.db.prepare('SELECT last_error FROM mail_accounts WHERE id = ?').get(account.id).last_error, 'E_IMAP_UIDVALIDITY')
    // A plain sync now fails fast (no network round-trip).
    const mark = mock.commands.length
    await assert.rejects(
      mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW }),
      (error) => error.code === 'E_IMAP_UIDVALIDITY',
    )
    assert.equal(mock.commands.length, mark, 'needs_resync must be detected before connecting again')
    // New UID space with the same Message-IDs: --full dedupes and rewrites the cursor.
    mock.state.messages = [
      { uid: 10, raw: Buffer.from(makeEml({ messageId: '<u1@example.com>' }), 'utf8') },
      { uid: 11, raw: Buffer.from(makeEml({ messageId: '<u2@example.com>' }), 'utf8') },
    ]
    const full = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, full: true, now: HOUR_NOW })
    assert.equal(full.inserted, 0)
    assert.equal(full.skipped, 2)
    const recovered = cursorOf(space.store, account.id)
    assert.equal(recovered.status, 'ok')
    assert.equal(recovered.uidvalidity, '200')
    assert.equal(recovered.last_uid, 11)
    assert.equal(count(space.store, 'mail_messages'), 2)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: attachments are metadata only and no attachment bytes are written under the home', async () => {
  const mock = await startMockImap({ messages: [makeEmlWithAttachment()] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const result = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    assert.equal(result.inserted, 1)
    const message = mailList(space.store, {}).messages[0]
    assert.deepEqual(message.attachments, [{ name: 'quote.pdf', size: 17, mime: 'application/pdf' }])
    const body = mailShow(space.store, message.id, { body: true }).message.bodyText
    assert.match(body, /我周五前把报价发给你/)
    assert.equal(body.includes('hello pdf content'), false, 'attachment bytes must not be in the retained body')
    const files = readdirSync(space.home, { recursive: true })
      .map((entry) => String(entry).replace(/\\/g, '/'))
      .sort()
    assert.deepEqual(files, ['credentials', 'credentials/imap', 'credentials/imap/' + account.id + '.json'])
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: an oversize message is stored header-only (metadata) without downloading the body', async () => {
  const mock = await startMockImap({ messages: [makeEml({ messageId: '<big@example.com>', subject: '大附件', body: '我周五前发报价。'.repeat(50) })] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const result = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, maxMessageBytes: 10, now: HOUR_NOW })
    assert.equal(result.inserted, 1)
    const message = mailList(space.store, {}).messages[0]
    assert.equal(message.status, 'oversize')
    assert.equal(message.retained, false)
    assert.equal(message.subject, '大附件')
    assert.equal(mock.commands.some((command) => /BODY\.PEEK\[\]/i.test(command)), false, 'the body of an oversize message must never be fetched')
    assert.throws(() => mailShow(space.store, message.id, { body: true }), (error) => error.code === 'E_MAIL_NOT_RETAINED')
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: --dry-run writes nothing but reports what would be inserted', async () => {
  const mock = await startMockImap({ messages: [makeEml({ messageId: '<dry@example.com>' })] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const dry = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, dryRun: true, now: HOUR_NOW })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.inserted, 0)
    assert.equal(dry.fetched, 1)
    assert.equal(count(space.store, 'mail_messages'), 0)
    assert.equal(count(space.store, 'mail_cursors'), 0)
    assert.equal(count(space.store, 'mail_sync_runs'), 0)
    assert.equal(space.store.db.prepare('SELECT last_sync_at FROM mail_accounts WHERE id = ?').get(account.id).last_sync_at, null)
    const real = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    assert.equal(real.inserted, 1)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

function failingRunStore(store, sqlPattern) {
  const db = new Proxy(store.db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql)
          if (!sqlPattern.test(sql)) return statement
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'run') return () => { throw new Error('injected failure') }
              const value = Reflect.get(statementTarget, statementProperty)
              return typeof value === 'function' ? value.bind(statementTarget) : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return Object.assign(Object.create(store), { db })
}

test('mail sync: a failure inside the batch transaction rolls back messages, cursor and run row', async () => {
  const mock = await startMockImap({ messages: [makeEml({ messageId: '<r1@example.com>' }), makeEml({ messageId: '<r2@example.com>' })] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    const failing = failingRunStore(space.store, /INSERT INTO mail_sync_runs/)
    await assert.rejects(
      mailSync(failing, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW }),
      /injected failure/,
    )
    assert.equal(count(space.store, 'mail_messages'), 0)
    assert.equal(count(space.store, 'mail_cursors'), 0)
    assert.equal(count(space.store, 'mail_sync_runs'), 0)
    // The same account still syncs normally afterwards (no torn half-batch).
    const retry = await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW })
    assert.equal(retry.inserted, 2)
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: the product path always uses TLS and rejects a plaintext IMAP server', async () => {
  const mock = await startMockImap({ messages: [makeEml()] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    await assert.rejects(
      mailSync(space.store, account.id, { home: space.home, timeoutMs: 1500 }),
      (error) => error.code === 'E_IMAP_TLS',
    )
    assert.equal(mock.commands.some((command) => /LOGIN/i.test(command)), false, 'no cleartext LOGIN may be sent')
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail sync: STARTTLS is refused when not advertised, and a failed upgrade never logs in over cleartext', async () => {
  const noStartTls = await startMockImap({ advertiseStarttls: false })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: noStartTls.port, tls: 'starttls' })
    await assert.rejects(
      mailSync(space.store, account.id, { home: space.home, timeoutMs: 1500 }),
      (error) => error.code === 'E_IMAP_TLS',
    )
    assert.ok(noStartTls.commands.some((command) => /CAPABILITY/i.test(command)))
    assert.equal(noStartTls.commands.some((command) => /STARTTLS/i.test(command)), false)
    assert.equal(noStartTls.commands.some((command) => /LOGIN/i.test(command)), false)
  } finally {
    await noStartTls.close()
    space.cleanup()
  }
  const broken = await startMockImap({ advertiseStarttls: true, failStarttls: true })
  const second = openMailStore()
  try {
    const account = addTestAccount(second.store, second.home, { port: broken.port, tls: 'starttls' })
    await assert.rejects(
      mailSync(second.store, account.id, { home: second.home, timeoutMs: 1500 }),
      (error) => error.code === 'E_IMAP_TLS',
    )
    assert.ok(broken.commands.some((command) => /STARTTLS/i.test(command)))
    assert.equal(broken.commands.some((command) => /LOGIN/i.test(command)), false)
  } finally {
    await broken.close()
    second.cleanup()
  }
})

test('mail sync: missing credentials and unknown accounts fail before any network I/O', async () => {
  const mock = await startMockImap({ messages: [makeEml()] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    removeImapCredential(account.id, { home: space.home })
    await assert.rejects(
      mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: HOUR_NOW }),
      (error) => error.code === 'E_MAIL_CREDENTIALS_MISSING',
    )
    await assert.rejects(
      mailSync(space.store, 'acct_missing', { home: space.home, connect: mock.connect, now: HOUR_NOW }),
      (error) => error.code === 'E_MAIL_ACCOUNT_NOT_FOUND',
    )
    assert.equal(mock.commands.length, 0)
    assert.equal(mailAccountList(space.store, { home: space.home }).total, 1)
  } finally {
    await mock.close()
    space.cleanup()
  }
})
