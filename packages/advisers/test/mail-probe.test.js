import assert from 'node:assert/strict'
import test from 'node:test'
import { removeImapCredential } from '../lib/credentials.js'
import { mailError, MAIL_ERROR_CODES } from '../lib/mail-errors.js'
import { DEFAULT_MAIL_PROBE_TIMEOUT_MS, mailAccountTest } from '../lib/mail-probe.js'
import { ensureLocalMailAccount } from '../lib/mail-store.js'
import { addTestAccount, openMailStore } from './mail-fixture.js'

const SECRET = 'app-password-secret'

function count(store, table) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
}

/** A fake lib/mail-imap.js session; every probe call is recorded, message calls fail loudly. */
function makeSession(overrides = {}) {
  const calls = []
  const session = {
    calls,
    async capability() {
      calls.push('capability')
      if (overrides.hangCapability) return new Promise(() => {})
      if (overrides.capabilityError) throw overrides.capabilityError
      return overrides.capabilities ?? ['IMAP4rev1']
    },
    async examine(mailbox) {
      calls.push('examine:' + mailbox)
      if (overrides.examineError) throw overrides.examineError
      return overrides.box ?? { mailbox, exists: 0, uidValidity: '1', uidNext: '2' }
    },
    async logout() { calls.push('logout') },
    destroy() { calls.push('destroy') },
    // The probe must never ask for message data; a call here fails the test loudly.
    fetchMessages() { calls.push('fetch'); throw new Error('mail probe must never FETCH') },
    searchSince() { calls.push('search'); throw new Error('mail probe must never SEARCH') },
    searchUidRange() { calls.push('search'); throw new Error('mail probe must never SEARCH') },
  }
  return session
}

function probe(space, ref, options = {}) {
  return mailAccountTest(space.store, ref, { home: space.home, ...options })
}

test('mail account test: TLS probe reports CAPABILITY + EXAMINE and writes nothing to the ledger', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    const session = makeSession({
      capabilities: ['imap4rev1', 'UIDPLUS', 'AUTH=PLAIN', 'auth=plain', 'IDLE', 'LITERAL+'],
      box: { mailbox: 'INBOX', exists: 42, uidValidity: '424242', uidNext: '900' },
    })
    let opened
    const auditBefore = count(space.store, 'audit')
    const result = await probe(space, account.id, {
      openSession: async (params) => { opened = params; return session },
    })
    assert.equal(result.ok, true)
    assert.equal(result.command, 'mail account test')
    assert.equal(result.accountId, account.id)
    assert.equal(result.host, '127.0.0.1')
    assert.equal(result.port, 993)
    assert.equal(result.tls, 'tls')
    assert.equal(result.mailbox, 'INBOX')
    assert.equal(result.uidValidity, '424242')
    assert.equal(result.messages, 42)
    assert.equal(Number.isInteger(result.latencyMs) && result.latencyMs >= 0, true)
    assert.deepEqual(result.capabilities, {
      count: 5,
      list: ['AUTH=PLAIN', 'IDLE', 'IMAP4REV1', 'LITERAL+', 'UIDPLUS'],
      flags: { starttls: false, uidplus: true, idle: true, move: false },
      auth: ['PLAIN'],
    })
    assert.equal(opened.host, '127.0.0.1')
    assert.equal(opened.port, 993)
    assert.equal(opened.tls, 'tls')
    assert.equal(opened.user, 'me@example.com')
    assert.equal(opened.pass, SECRET)
    assert.ok(opened.timeoutMs > 0 && opened.timeoutMs <= DEFAULT_MAIL_PROBE_TIMEOUT_MS)
    assert.ok(opened.idleTimeoutMs > 0 && opened.idleTimeoutMs <= DEFAULT_MAIL_PROBE_TIMEOUT_MS)
    assert.equal('connect' in opened, false, 'the product path must not use the test socket injection')
    assert.deepEqual(session.calls, ['capability', 'examine:INBOX', 'logout', 'destroy'])
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'the probe result never carries the password')
    assert.equal(space.store.db.prepare('SELECT last_error FROM mail_accounts WHERE id = ?').get(account.id).last_error, null)
    assert.equal(count(space.store, 'mail_messages'), 0)
    assert.equal(count(space.store, 'mail_cursors'), 0)
    assert.equal(count(space.store, 'mail_sync_runs'), 0)
    assert.equal(count(space.store, 'audit'), auditBefore, 'the probe must not append an audit row')
  } finally {
    space.cleanup()
  }
})

test('mail account test: STARTTLS account uses the configured transport and EXAMINEs the mailbox override', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { name: 'secure', tls: 'starttls', port: 143, mailbox: 'Work' })
    const session = makeSession()
    let opened
    const result = await probe(space, 'secure', {
      mailbox: 'Archive',
      openSession: async (params) => { opened = params; return session },
    })
    assert.equal(result.accountId, account.id)
    assert.equal(result.tls, 'starttls')
    assert.equal(result.mailbox, 'Archive')
    assert.equal(opened.tls, 'starttls')
    assert.equal(opened.port, 143)
    assert.deepEqual(session.calls, ['capability', 'examine:Archive', 'logout', 'destroy'])
    const fallback = await probe(space, account.id, { openSession: async () => makeSession({ box: {} }) })
    assert.equal(fallback.mailbox, 'Work', 'the account mailbox is the default EXAMINE target')
    assert.equal(fallback.uidValidity, null)
    assert.equal(fallback.messages, null)
  } finally {
    space.cleanup()
  }
})

test('mail account test: missing credentials and unknown accounts fail before opening a session', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    removeImapCredential(account.id, { home: space.home })
    let opened = false
    await assert.rejects(
      probe(space, account.id, { openSession: async () => { opened = true } }),
      (error) => error.code === 'E_MAIL_CREDENTIALS_MISSING',
    )
    assert.equal(opened, false)
    await assert.rejects(
      probe(space, 'acct_missing', { openSession: async () => { opened = true } }),
      (error) => error.code === 'E_MAIL_ACCOUNT_NOT_FOUND',
    )
    assert.equal(opened, false)
  } finally {
    space.cleanup()
  }
})

test('mail account test: non-IMAP accounts and invalid probe options are E_MAIL_CONFIG without network', async () => {
  const space = openMailStore()
  try {
    const local = ensureLocalMailAccount(space.store)
    const account = addTestAccount(space.store, space.home)
    let opened = false
    const openSession = async () => { opened = true }
    await assert.rejects(
      probe(space, local.id, { openSession }),
      (error) => error.code === 'E_MAIL_CONFIG',
    )
    await assert.rejects(
      probe(space, account.id, { openSession, timeoutMs: 0 }),
      (error) => error.code === 'E_MAIL_CONFIG',
    )
    await assert.rejects(
      probe(space, account.id, { openSession, mailbox: '   ' }),
      (error) => error.code === 'E_MAIL_CONFIG',
    )
    await assert.rejects(
      probe(space, account.id, { openSession, mailbox: 'INBOX' + String.fromCharCode(0) + 'x' }),
      (error) => error.code === 'E_MAIL_CONFIG',
    )
    await assert.rejects(
      probe(space, account.id, { openSession: 'not-a-function' }),
      (error) => error.code === 'E_MAIL_CONFIG',
    )
    assert.equal(opened, false, 'no probe may reach the opener')
  } finally {
    space.cleanup()
  }
})

test('mail account test: login rejection maps to E_IMAP_AUTH and never echoes the password', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    const failures = [
      new Error('AUTHENTICATIONFAILED invalid credentials'),
      Object.assign(new Error('LOGIN failed'), { code: 'EAUTH' }),
      mailError(MAIL_ERROR_CODES.IMAP_AUTH, 'IMAP authentication failed'),
    ]
    for (const failure of failures) {
      await assert.rejects(
        probe(space, account.id, { openSession: async () => { throw failure } }),
        (error) => {
          assert.equal(error.code, 'E_IMAP_AUTH')
          assert.equal(error.message.includes(SECRET), false)
          return true
        },
      )
    }
  } finally {
    space.cleanup()
  }
})

test('mail account test: TLS and connection failures map to the existing IMAP error codes', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    const cases = [
      [Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), 'E_IMAP_TLS'],
      [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:993'), { code: 'ECONNREFUSED' }), 'E_IMAP_PROTOCOL'],
    ]
    for (const [failure, expectedCode] of cases) {
      await assert.rejects(
        probe(space, account.id, { openSession: async () => { throw failure } }),
        (error) => {
          assert.equal(error.code, expectedCode)
          assert.equal(error.message.includes(SECRET), false)
          return true
        },
      )
    }
  } finally {
    space.cleanup()
  }
})

test('mail account test: a rejected EXAMINE and an unusable session map to E_IMAP_PROTOCOL and log out', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    const rejected = makeSession({
      examineError: mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'IMAP EXAMINE was rejected by the server: [NONEXISTENT]'),
    })
    await assert.rejects(
      probe(space, account.id, { openSession: async () => rejected }),
      (error) => error.code === 'E_IMAP_PROTOCOL',
    )
    assert.deepEqual(rejected.calls, ['capability', 'examine:INBOX', 'logout', 'destroy'])
    let closed = 0
    const incomplete = { logout() { closed += 1 }, destroy() { closed += 1 } }
    await assert.rejects(
      probe(space, account.id, { openSession: async () => incomplete }),
      (error) => error.code === 'E_IMAP_PROTOCOL',
    )
    assert.equal(closed, 2, 'an unusable session is still logged out and destroyed')
    const badCapabilities = makeSession({ capabilities: 'not-an-array' })
    await assert.rejects(
      probe(space, account.id, { openSession: async () => badCapabilities }),
      (error) => error.code === 'E_IMAP_PROTOCOL',
    )
    assert.deepEqual(badCapabilities.calls, ['capability', 'logout', 'destroy'])
  } finally {
    space.cleanup()
  }
})

test('mail account test: unexpected session errors are sanitised to E_IMAP_PROTOCOL and cleaned up', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    const esc = String.fromCharCode(27)
    const session = makeSession({ capabilityError: new Error('boom ' + esc + '[31mred' + esc + '[0m') })
    await assert.rejects(
      probe(space, account.id, { openSession: async () => session }),
      (error) => {
        assert.equal(error.code, 'E_IMAP_PROTOCOL')
        assert.match(error.message, /boom/)
        assert.equal(error.message.includes(esc), false, 'terminal escapes must never reach stderr')
        return true
      },
    )
    assert.deepEqual(session.calls, ['capability', 'logout', 'destroy'])
  } finally {
    space.cleanup()
  }
})

test('mail account test: a hanging server hits the deadline with E_IMAP_TIMEOUT and is torn down', async () => {
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home)
    const hanging = makeSession({ hangCapability: true })
    const started = Date.now()
    await assert.rejects(
      probe(space, account.id, { timeoutMs: 25, openSession: async () => hanging }),
      (error) => {
        assert.equal(error.code, 'E_IMAP_TIMEOUT')
        assert.match(error.message, /timed out after 25ms/)
        return true
      },
    )
    assert.ok(Date.now() - started < 2_000, 'the probe must not outlive its deadline')
    assert.deepEqual(hanging.calls, ['capability', 'logout', 'destroy'])
    // An opener that never settles is bounded by the same deadline.
    await assert.rejects(
      probe(space, account.id, { timeoutMs: 25, openSession: () => new Promise(() => {}) }),
      (error) => error.code === 'E_IMAP_TIMEOUT',
    )
    // A session that arrives after the deadline is destroyed, not leaked.
    let lateSession
    const lateOpener = () => new Promise((resolve) => {
      setTimeout(() => { lateSession = makeSession(); resolve(lateSession) }, 60)
    })
    await assert.rejects(
      probe(space, account.id, { timeoutMs: 20, openSession: lateOpener }),
      (error) => error.code === 'E_IMAP_TIMEOUT',
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.ok(lateSession, 'the late opener eventually resolves')
    assert.deepEqual(lateSession.calls, ['destroy'])
  } finally {
    space.cleanup()
  }
})
