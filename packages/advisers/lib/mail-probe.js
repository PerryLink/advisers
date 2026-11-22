/**
 * Read-only IMAP connectivity probe behind `advisers mail account test` (0.4.x).
 *
 * The command exists so a user can validate an account before syncing: it opens
 * ONE session to the configured host/port with the configured transport (implicit
 * TLS on 993 or STARTTLS on 143, never cleartext), logs in, asks CAPABILITY and
 * runs EXAMINE on the account mailbox (or an explicit --mailbox override). It
 * never fetches message data and never writes the ledger:
 *
 * - no FETCH / UID SEARCH / STORE; no message body or header is read;
 * - no mail row, cursor, sync run or audit row is written (lib/mail.js owns writes);
 * - no message content is part of the result and the password is never echoed.
 *
 * The result has a small, frozen-shape contract (see mailAccountTest):
 *   { ok, command, accountId, host, port, tls, mailbox, latencyMs,
 *     uidValidity, messages, capabilities }
 * where capabilities is a summary { count, list, flags, auth } of the post-LOGIN
 * CAPABILITY tokens (unique, upper-cased, sorted; unknown tokens dropped).
 *
 * The whole probe has ONE deadline, DEFAULT_MAIL_PROBE_TIMEOUT_MS (30 s); a caller
 * may pass a shorter timeoutMs (tests do). An injected `openSession` lets tests
 * supply a fake session and never touch the network - the product path always
 * uses lib/mail-imap.js. Failures map to the EXISTING registered codes
 * (lib/error-codes.js); this module introduces no new error code:
 *
 *   E_MAIL_CONFIG              unsupported account/transport, bad probe option
 *   E_MAIL_ACCOUNT_NOT_FOUND   the account ref does not resolve
 *   E_MAIL_CREDENTIALS_MISSING no stored credential for the account
 *   E_CREDENTIALS_INSECURE     from lib/credentials.js (unsafe credential file)
 *   E_IMAP_AUTH                login rejected / authentication error
 *   E_IMAP_TLS                 TLS handshake, certificate or STARTTLS failure
 *   E_IMAP_TIMEOUT             the probe deadline elapsed
 *   E_IMAP_PROTOCOL            anything else (bad status line, rejected EXAMINE)
 */
import { readImapCredential } from './credentials.js'
import { isMailError, mailError, MAIL_ERROR_CODES } from './mail-errors.js'
import { openMailImapSession } from './mail-imap.js'
import { assertMailTables, getMailAccount } from './mail-store.js'
import { sanitizeConsoleText } from './text-safe.js'

/** Default total deadline for one probe (the documented CLI contract is 30 s). */
export const DEFAULT_MAIL_PROBE_TIMEOUT_MS = 30_000
const MAX_MAIL_PROBE_TIMEOUT_MS = 300_000
const MAIL_PROBE_MAX_MAILBOX_CHARS = 200
const MAIL_PROBE_MAX_CAPABILITIES = 64
const MAIL_PROBE_MAX_CAPABILITY_CHARS = 64
const CLEANUP_GRACE_MS = 1_000
const CLEANUP_GRACE_AFTER_TIMEOUT_MS = 250
const IMAP_TLS_MODES = Object.freeze(['tls', 'starttls'])

function probeTimeoutError(timeoutMs) {
  return mailError(
    MAIL_ERROR_CODES.IMAP_TIMEOUT,
    'IMAP probe timed out after ' + timeoutMs + 'ms',
    'check the network, the account host/port and the server certificate; this probe never fetches message data',
  )
}

function normalizeTimeoutMs(value) {
  if (value == null) return DEFAULT_MAIL_PROBE_TIMEOUT_MS
  const timeoutMs = Number(value)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MAIL_PROBE_TIMEOUT_MS) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail probe timeout must be an integer between 1 and ' + MAX_MAIL_PROBE_TIMEOUT_MS + 'ms')
  }
  return timeoutMs
}

function normalizeMailbox(value, fallback) {
  const raw = value == null ? fallback : value
  if (typeof raw !== 'string') throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail probe mailbox must be a string')
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail probe mailbox must be a single line without control characters')
  }
  const mailbox = raw.trim()
  if (!mailbox) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail probe mailbox must not be empty')
  if (Array.from(mailbox).length > MAIL_PROBE_MAX_MAILBOX_CHARS) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail probe mailbox must be at most ' + MAIL_PROBE_MAX_MAILBOX_CHARS + ' characters')
  }
  return mailbox
}

function resolveOpener(openSession) {
  if (openSession == null) return openMailImapSession
  if (typeof openSession !== 'function') {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail probe openSession must be a function (test injection point)')
  }
  return openSession
}

/** Bound one clean-up await without leaving a timer behind (both outcomes). */
async function settleWithin(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('IMAP clean-up timed out')), timeoutMs)
  })
  timeout.catch(() => {})
  try {
    await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createDeadline(timeoutMs) {
  const expiresAt = Date.now() + timeoutMs
  let timer = null
  let expired = false
  let rejectDeadline
  const deadlinePromise = new Promise((resolve, reject) => { rejectDeadline = reject })
  deadlinePromise.catch(() => {})
  timer = setTimeout(() => {
    timer = null
    expired = true
    rejectDeadline(probeTimeoutError(timeoutMs))
  }, timeoutMs)
  return {
    expired: () => expired,
    remaining: () => Math.max(0, expiresAt - Date.now()),
    race: (promise) => Promise.race([promise, deadlinePromise]),
    dispose: () => { if (timer) { clearTimeout(timer); timer = null } },
  }
}

function destroySessionQuietly(session) {
  if (!session) return
  try { session.destroy?.() } catch {}
}

async function closeSession(session, graceMs) {
  if (!session) return
  try {
    if (typeof session.logout === 'function') {
      await settleWithin(Promise.resolve().then(() => session.logout()), graceMs)
    }
  } catch {}
  destroySessionQuietly(session)
}

async function openProbeSession(openSession, params, deadline, timeoutMs) {
  const opened = Promise.resolve().then(() => openSession(params))
  const guarded = opened.then((session) => {
    if (deadline.expired()) {
      destroySessionQuietly(session)
      throw probeTimeoutError(timeoutMs)
    }
    return session
  })
  return deadline.race(guarded)
}

function assertProbeSession(session) {
  if (!session || typeof session !== 'object') {
    throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'the IMAP session was not created')
  }
  if (typeof session.capability !== 'function' || typeof session.examine !== 'function') {
    throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'the IMAP session does not expose CAPABILITY/EXAMINE')
  }
}

function summarizeCapabilities(rawCapabilities) {
  if (!Array.isArray(rawCapabilities)) {
    throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'the IMAP CAPABILITY response was not understood')
  }
  const names = []
  for (const raw of rawCapabilities.slice(0, 512)) {
    if (typeof raw !== 'string') continue
    const name = sanitizeConsoleText(raw, { max: MAIL_PROBE_MAX_CAPABILITY_CHARS }).trim().toUpperCase()
    if (!name || !/^[A-Z0-9]/.test(name) || !/^[A-Z0-9._=+-]+$/.test(name)) continue
    if (!names.includes(name)) names.push(name)
    if (names.length >= MAIL_PROBE_MAX_CAPABILITIES) break
  }
  names.sort()
  return {
    count: names.length,
    list: names,
    flags: {
      starttls: names.includes('STARTTLS'),
      uidplus: names.includes('UIDPLUS'),
      idle: names.includes('IDLE'),
      move: names.includes('MOVE'),
    },
    auth: names.filter((name) => name.startsWith('AUTH=')).map((name) => name.slice('AUTH='.length)),
  }
}

function normalizeUidValidity(value) {
  if (value == null) return null
  const text = String(value).trim()
  return /^[0-9]+$/.test(text) ? text : null
}

function normalizeMessageCount(value) {
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 ? count : null
}

function mapProbeError(error, timeoutMs) {
  if (isMailError(error)) return error
  const rawCode = typeof error?.code === 'string' ? error.code : ''
  const rawMessage = String(error?.message ?? error ?? '')
  const detail = rawCode + ' ' + rawMessage
  if (error?.imapTimeout || rawCode === 'ETIMEDOUT' || /timed out|timeout/i.test(rawMessage)) {
    return probeTimeoutError(timeoutMs)
  }
  if (/auth|login|credential|password|AUTHENTICATIONFAILED/i.test(detail)) {
    return mailError(
      MAIL_ERROR_CODES.IMAP_AUTH,
      'IMAP authentication failed',
      'check the account username and app password; modern providers may require OAuth (not supported)',
    )
  }
  if (/tls|ssl|certificate|handshake|self.signed|unable to verify|EPROTO/i.test(detail)) {
    return mailError(
      MAIL_ERROR_CODES.IMAP_TLS,
      'IMAP TLS connection failed: ' + sanitizeConsoleText(rawMessage, { max: 300 }),
      'the server certificate must be valid for the configured host; advisers never falls back to cleartext',
    )
  }
  return mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'IMAP probe failed: ' + (sanitizeConsoleText(rawMessage, { max: 300 }) || 'unknown error'))
}

/**
 * Probe one configured IMAP account read-only: connect (TLS/STARTTLS) + LOGIN +
 * CAPABILITY + EXAMINE, then log out. Nothing is fetched and nothing is written.
 *
 * @param {{ db: any }} store open ledger (SQLite)
 * @param {string} accountRef account id or (case-insensitive) account name
 * @param {{ home?: string, timeoutMs?: number, mailbox?: string, openSession?: Function }} [options]
 * @returns {Promise<{
 *   ok: true, command: 'mail account test', accountId: string, host: string,
 *   port: number, tls: 'tls' | 'starttls', mailbox: string, latencyMs: number,
 *   uidValidity: string | null, messages: number | null,
 *   capabilities: {
 *     count: number,
 *     list: string[],
 *     flags: { starttls: boolean, uidplus: boolean, idle: boolean, move: boolean },
 *     auth: string[],
 *   },
 * }>}
 */
export async function mailAccountTest(store, accountRef, options = {}) {
  const startedMs = Date.now()
  assertMailTables(store)
  if (options == null || typeof options !== 'object') {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account test options must be an object')
  }
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
  const account = getMailAccount(store, accountRef)
  if (!IMAP_TLS_MODES.includes(account.tls)) {
    throw mailError(
      MAIL_ERROR_CODES.CONFIG,
      'account ' + account.name + ' is not an IMAP account',
      'the local .eml import account has no server to probe; add an IMAP account with `advisers mail account add`',
    )
  }
  const mailbox = normalizeMailbox(options.mailbox, account.mailbox)
  const openSession = resolveOpener(options.openSession)
  const credential = readImapCredential(account.id, { home: options.home })
  if (!credential) {
    throw mailError(
      MAIL_ERROR_CODES.CREDENTIALS_MISSING,
      'no stored credential for mail account ' + account.name,
      'run `advisers mail account add` again and provide the password through the TTY prompt or --pass-stdin',
    )
  }
  const deadline = createDeadline(timeoutMs)
  let session
  try {
    const remaining = Math.max(1, deadline.remaining())
    session = await openProbeSession(openSession, {
      host: account.host,
      port: account.port,
      tls: account.tls,
      user: credential.user || account.username,
      pass: credential.pass,
      timeoutMs: remaining,
      idleTimeoutMs: remaining,
    }, deadline, timeoutMs)
    assertProbeSession(session)
    const rawCapabilities = await deadline.race(Promise.resolve().then(() => session.capability()))
    const capabilities = summarizeCapabilities(rawCapabilities)
    const box = await deadline.race(Promise.resolve().then(() => session.examine(mailbox)))
    if (!box || typeof box !== 'object') {
      throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'the IMAP EXAMINE response was not understood')
    }
    return {
      ok: true,
      command: 'mail account test',
      accountId: account.id,
      host: account.host,
      port: account.port,
      tls: account.tls,
      mailbox,
      latencyMs: Math.max(0, Date.now() - startedMs),
      uidValidity: normalizeUidValidity(box.uidValidity),
      messages: normalizeMessageCount(box.exists),
      capabilities,
    }
  } catch (error) {
    throw mapProbeError(error, timeoutMs)
  } finally {
    deadline.dispose()
    if (session) {
      await closeSession(session, deadline.expired() ? CLEANUP_GRACE_AFTER_TIMEOUT_MS : CLEANUP_GRACE_MS)
    }
  }
}
