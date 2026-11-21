/**
 * SQLite persistence for the 0.4.0 mail entry (schema v22 tables owned by
 * lib/sqlite.js: mail_accounts / mail_cursors / mail_messages /
 * mail_sync_runs). This module never creates tables and never touches
 * credentials; it only reads/writes the mail rows through an open
 * SqliteStore (use store.mutate()/transaction() for the write helpers that
 * are documented as transaction-internal).
 *
 * Invariants:
 * - a message row keeps `body_text` only within MAIL_MAX_BODY_BYTES; clearing
 *   it (retention / purge) keeps the metadata, body_sha256 and dedupe key, so
 *   re-syncing the mailbox can never recreate the row;
 * - dedupe key: Message-ID first, then (mailbox, UIDVALIDITY, UID), then a
 *   canonical content hash for .eml imports without a Message-ID. The body
 *   hash is NOT a dedupe key (signature/client differences would drift);
 * - attachments are metadata only: [{ name, size, mime }]; no attachment
 *   bytes are stored anywhere under ADVISERS_HOME;
 * - a sync batch writes messages + cursor + account last_sync_at + the run row
 *   in ONE BEGIN IMMEDIATE (see applyMailSyncBatch); the cursor only advances
 *   past successful rows, never past a failed UID.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mailError, MAIL_ERROR_CODES } from './mail-errors.js'

export const MAIL_DEFAULT_RETENTION_DAYS = 30
export const MAIL_MAX_RETENTION_DAYS = 3650
export const MAIL_DEFAULT_SYNC_LIMIT = 50
export const MAIL_MAX_SYNC_LIMIT = 200
export const MAIL_DEFAULT_LS_LIMIT = 50
export const MAIL_MAX_LS_LIMIT = 500
export const MAIL_MAX_BODY_BYTES = 256 * 1024
export const MAIL_MAX_MESSAGE_BYTES = 5 * 1024 * 1024
export const MAIL_MAX_ATTACHMENTS = 50
export const MAIL_TLS_MODES = Object.freeze(['tls', 'starttls'])
export const MAIL_ACCOUNT_STATUSES = Object.freeze(['active', 'removed'])
export const MAIL_MESSAGE_STATUSES = Object.freeze(['new', 'extracted', 'linked', 'dismissed', 'oversize', 'metadata'])
export const MAIL_LOCAL_ACCOUNT_ID = 'acct_local_eml'
export const MAIL_LOCAL_MAILBOX = 'local'
export const MAIL_MAX_ACCOUNT_NAME_CHARS = 120
export const MAIL_MAX_SUBJECT_CHARS = 500
export const MAIL_MAX_FROM_CHARS = 320

const REQUIRED_TABLES = ['mail_accounts', 'mail_cursors', 'mail_messages', 'mail_sync_runs']
const DAY_MS = 86_400_000
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/

function nowDate(now) {
  const value = now instanceof Date ? now : new Date(now ?? Date.now())
  if (!Number.isFinite(value.getTime())) throw mailError(MAIL_ERROR_CODES.CONFIG, 'invalid clock value')
  return value
}

export function isoOf(now) {
  return nowDate(now).toISOString()
}

function normalizeIso(value, field) {
  if (value == null || value === '') return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw mailError(MAIL_ERROR_CODES.CONFIG, field + ' is not a valid date')
  return parsed.toISOString()
}

export function parseJson(value, fallback) {
  if (value == null) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null ? fallback : parsed
  } catch { return fallback }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function randomId(prefix) {
  return prefix + randomBytes(8).toString('hex')
}

function singleLine(value, max) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

function normalizeMessageId(value) {
  let text = String(value == null ? '' : value).trim()
  if (!text) return ''
  const wrapped = /^<([^>]+)>$/.exec(text)
  if (wrapped) text = wrapped[1].trim()
  if (!text || /\s/.test(text) || text.length > 512) return ''
  return text
}

function canonicalText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncateUtf8(text, maxBytes) {
  const value = String(text == null ? '' : text)
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes - 64) low = middle
    else high = middle - 1
  }
  return value.slice(0, low) + '\n[body truncated by advisers]'
}

/** Fail with a stable code when the v22 mail tables are missing. */
export function assertMailTables(store) {
  if (!store || typeof store.db?.prepare !== 'function') {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail commands require the SQLite ledger (JSON store is not supported)')
  }
  let rows
  try {
    rows = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  } catch (error) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'the ledger database is not readable: ' + String(error?.message ?? error).slice(0, 200))
  }
  const present = new Set(rows.map((row) => row.name))
  const missing = REQUIRED_TABLES.filter((name) => !present.has(name))
  if (missing.length) {
    throw mailError('E_SCHEMA_STALE', 'mail requires the v22 schema but this ledger is missing: ' + missing.join(', '), 'upgrade advisers and run `advisers init` to migrate the ledger')
  }
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return []
  const out = []
  for (const item of attachments.slice(0, 500)) {
    if (out.length >= MAIL_MAX_ATTACHMENTS) break
    if (!item || typeof item !== 'object') continue
    const name = singleLine(item.name, 120)
    const size = Number(item.size)
    const mime = singleLine(item.mime, 120)
    if (!name) continue
    out.push({ name, size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0, mime: mime || 'application/octet-stream' })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Accounts                                                           */
/* ------------------------------------------------------------------ */

function validateAccountText(value, field, max) {
  if (typeof value !== 'string') throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account ' + field + ' is required')
  const text = singleLine(value, max + 1)
  if (!text || text.length > max) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account ' + field + ' must be 1-' + max + ' characters')
  return text
}

/**
 * Validate and normalise a mail account config. Rejects cleartext IMAP
 * (`secure: false` / `tls: 'none'`) with E_MAIL_CONFIG: RFC 8314 removed
 * cleartext mail access and this module has no plaintext product path.
 */
export function prepareMailAccount(config = {}, { now, id } = {}) {
  if (!config || typeof config !== 'object') throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account config is required')
  if (config.secure === false || config.secure === 0 || config.insecure === true) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'cleartext IMAP is not supported; mail sync requires implicit TLS (993) or STARTTLS', 'drop --insecure/secure=0 and use --port 993')
  }
  const name = validateAccountText(config.name, 'name', MAIL_MAX_ACCOUNT_NAME_CHARS)
  if (typeof config.host !== 'string' || !config.host.trim()) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account host is required')
  const host = singleLine(config.host, 256)
  if (!host || /[\s/\\]/.test(host)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account host is not a valid hostname')
  const requestedTls = config.tls == null ? undefined : String(config.tls).trim().toLowerCase()
  let tls
  if (requestedTls === undefined || requestedTls === '') tls = Number(config.port) === 143 ? 'starttls' : 'tls'
  else if (requestedTls === 'ssl' || requestedTls === 'implicit' || requestedTls === 'tls') tls = 'tls'
  else if (requestedTls === 'starttls') tls = 'starttls'
  else if (['none', 'plain', 'insecure', 'cleartext', '0', 'false'].includes(requestedTls)) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'cleartext IMAP is not supported (tls=' + requestedTls + ')', 'use tls (implicit TLS, 993) or starttls (143)')
  } else {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'unknown mail account tls mode: ' + String(config.tls), 'use tls or starttls')
  }
  const defaultPort = tls === 'starttls' ? 143 : 993
  const port = config.port == null ? defaultPort : Number(config.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account port must be an integer 1-65535')
  const username = validateAccountText(config.username, 'username', 320)
  const mailbox = config.mailbox == null ? 'INBOX' : singleLine(config.mailbox, 200)
  if (!mailbox) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account mailbox must not be empty')
  let retentionDays = config.retentionDays == null ? MAIL_DEFAULT_RETENTION_DAYS : Number(config.retentionDays)
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > MAIL_MAX_RETENTION_DAYS) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'retention-days must be an integer 0-' + MAIL_MAX_RETENTION_DAYS, '0 keeps bodies until an explicit mail purge')
  }
  const entityId = (value, field) => {
    if (value == null || value === '') return null
    if (typeof value !== 'string' || value.length > 200 || ABSOLUTE_PATH_RE.test(value.trim())) {
      throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account ' + field + ' must be an entity id string')
    }
    return value.trim()
  }
  const at = isoOf(now)
  return {
    id: id ?? randomId('acct_'),
    name,
    host,
    port,
    tls,
    username,
    mailbox,
    status: 'active',
    defaultMatterId: entityId(config.defaultMatterId, 'default-matter'),
    clientId: entityId(config.clientId, 'client'),
    retentionDays,
    lastSyncAt: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
  }
}

const mapAccountRow = (row) => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: Number(row.port),
  tls: row.tls,
  username: row.username,
  mailbox: row.mailbox,
  status: row.status,
  defaultMatterId: row.default_matter_id ?? undefined,
  clientId: row.client_id ?? undefined,
  retentionDays: Number(row.retention_days),
  lastSyncAt: row.last_sync_at ?? undefined,
  lastError: row.last_error ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export function insertMailAccount(store, account) {
  const duplicate = store.db.prepare("SELECT id FROM mail_accounts WHERE lower(name) = lower(?) AND status = 'active' LIMIT 1").get(account.name)
  if (duplicate) throw mailError(MAIL_ERROR_CODES.CONFIG, 'an active mail account named ' + JSON.stringify(account.name) + ' already exists', 'use a different --name or remove the old account first')
  store.db.prepare(
    'INSERT INTO mail_accounts(id,name,host,port,tls,username,mailbox,status,default_matter_id,client_id,retention_days,last_sync_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(account.id, account.name, account.host, account.port, account.tls, account.username, account.mailbox, account.status, account.defaultMatterId, account.clientId, account.retentionDays, account.lastSyncAt, account.lastError, account.createdAt, account.updatedAt)
  return account
}

export function getMailAccount(store, ref, { includeRemoved = false } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) throw mailError(MAIL_ERROR_CODES.ACCOUNT_NOT_FOUND, 'mail account is required', 'run `advisers mail account ls` to list accounts')
  const value = ref.trim()
  const row = store.db.prepare('SELECT * FROM mail_accounts WHERE id = ? OR lower(name) = lower(?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1').get(value, value, value)
  if (!row || (!includeRemoved && row.status === 'removed')) {
    throw mailError(MAIL_ERROR_CODES.ACCOUNT_NOT_FOUND, 'mail account not found: ' + value, 'run `advisers mail account ls` to list accounts')
  }
  return mapAccountRow(row)
}

export function listMailAccounts(store, { includeRemoved = false, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = includeRemoved
    ? store.db.prepare('SELECT * FROM mail_accounts ORDER BY created_at ASC, id ASC LIMIT ?').all(cap)
    : store.db.prepare("SELECT * FROM mail_accounts WHERE status = 'active' ORDER BY created_at ASC, id ASC LIMIT ?").all(cap)
  return rows.map(mapAccountRow)
}

const ACCOUNT_PATCHES = {
  name: 'name',
  mailbox: 'mailbox',
  status: 'status',
  defaultMatterId: 'default_matter_id',
  clientId: 'client_id',
  retentionDays: 'retention_days',
  lastSyncAt: 'last_sync_at',
  lastError: 'last_error',
}

export function updateMailAccount(store, accountId, patch = {}, { now } = {}) {
  const sets = []
  const values = []
  for (const [key, column] of Object.entries(ACCOUNT_PATCHES)) {
    if (!(key in patch)) continue
    let value = patch[key]
    if (key === 'status') {
      if (!MAIL_ACCOUNT_STATUSES.includes(value)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'unknown mail account status: ' + String(value))
    } else if (key === 'retentionDays') {
      value = Number(value)
      if (!Number.isInteger(value) || value < 0 || value > MAIL_MAX_RETENTION_DAYS) throw mailError(MAIL_ERROR_CODES.CONFIG, 'retention-days must be an integer 0-' + MAIL_MAX_RETENTION_DAYS)
    } else if (key === 'lastSyncAt') {
      value = value == null ? null : normalizeIso(value, 'last-sync-at')
    } else if (key === 'lastError') {
      value = value == null ? null : singleLine(value, 300)
    } else if (key === 'name') {
      value = validateAccountText(value, 'name', MAIL_MAX_ACCOUNT_NAME_CHARS)
    } else if (key === 'mailbox') {
      value = singleLine(value, 200)
      if (!value) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account mailbox must not be empty')
    } else if (value != null && (typeof value !== 'string' || value.length > 200)) {
      throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail account ' + key + ' must be an entity id string')
    }
    sets.push(column + ' = ?')
    values.push(value)
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  values.push(isoOf(now))
  values.push(accountId)
  store.db.prepare('UPDATE mail_accounts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values)
}

/** Transaction-internal: tombstone the account and delete its sync state. */
export function removeMailAccountData(store, accountId, { purgeMessages = false, now } = {}) {
  const at = isoOf(now)
  let messagesDeleted = 0
  if (purgeMessages) {
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?').get(accountId)
    messagesDeleted = Number(count?.n ?? 0)
    store.db.prepare('DELETE FROM mail_messages WHERE account_id = ?').run(accountId)
  }
  store.db.prepare('DELETE FROM mail_cursors WHERE account_id = ?').run(accountId)
  store.db.prepare('DELETE FROM mail_sync_runs WHERE account_id = ?').run(accountId)
  store.db.prepare("UPDATE mail_accounts SET status = 'removed', updated_at = ? WHERE id = ?").run(at, accountId)
  return { messagesDeleted }
}

/** Built-in account for the no-network .eml/.mbox fallback import. */
export function ensureLocalMailAccount(store, { now } = {}) {
  const existing = store.db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(MAIL_LOCAL_ACCOUNT_ID)
  if (existing) return mapAccountRow(existing)
  const at = isoOf(now)
  store.db.prepare(
    "INSERT OR IGNORE INTO mail_accounts(id,name,host,port,tls,username,mailbox,status,default_matter_id,client_id,retention_days,last_sync_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(MAIL_LOCAL_ACCOUNT_ID, 'Local .eml import', '(local)', 0, 'local', '(local)', MAIL_LOCAL_MAILBOX, 'active', null, null, MAIL_DEFAULT_RETENTION_DAYS, null, null, at, at)
  return getMailAccount(store, MAIL_LOCAL_ACCOUNT_ID, { includeRemoved: true })
}

/* ------------------------------------------------------------------ */
/* Cursors                                                            */
/* ------------------------------------------------------------------ */

const mapCursorRow = (row) => ({
  accountId: row.account_id,
  mailbox: row.mailbox,
  uidvalidity: row.uidvalidity ?? undefined,
  lastUid: row.last_uid == null ? undefined : Number(row.last_uid),
  uidnext: row.uidnext ?? undefined,
  status: row.status,
  updatedAt: row.updated_at,
})

export function getMailCursor(store, accountId, mailbox) {
  const row = store.db.prepare('SELECT * FROM mail_cursors WHERE account_id = ? AND mailbox = ?').get(accountId, mailbox)
  return row ? mapCursorRow(row) : undefined
}

/** Transaction-internal: upsert one mailbox cursor. */
export function putMailCursor(store, { accountId, mailbox, uidvalidity = null, lastUid = null, uidnext = null, status = 'ok', now } = {}) {
  store.db.prepare(
    'INSERT INTO mail_cursors(account_id,mailbox,uidvalidity,last_uid,uidnext,status,updated_at) VALUES(?,?,?,?,?,?,?) ' +
    'ON CONFLICT(account_id,mailbox) DO UPDATE SET uidvalidity=excluded.uidvalidity,last_uid=excluded.last_uid,uidnext=excluded.uidnext,status=excluded.status,updated_at=excluded.updated_at',
  ).run(accountId, mailbox, uidvalidity, lastUid, uidnext, status, isoOf(now))
}

/** Transaction-internal: mark the cursor as needing `mail sync --full`. */
export function markMailCursorNeedsResync(store, { accountId, mailbox, uidvalidity = null, uidnext = null, now } = {}) {
  putMailCursor(store, { accountId, mailbox, uidvalidity, lastUid: null, uidnext, status: 'needs_resync', now })
}

/* ------------------------------------------------------------------ */
/* Messages                                                           */
/* ------------------------------------------------------------------ */

/**
 * Stable dedupe key for one message (see file header).
 * @returns {string} 64-char lowercase sha256 hex
 */
export function mailDedupeKey({ accountId, mailbox = 'INBOX', uidvalidity = null, uid = null, messageId = '', from = '', subject = '', date = '', text = '' } = {}) {
  const messageKey = normalizeMessageId(messageId)
  if (messageKey) return sha256('message-id\u0000' + accountId + '\u0000' + messageKey)
  if (Number.isInteger(uid) && uid > 0) return sha256('uid\u0000' + accountId + '\u0000' + mailbox + '\u0000' + String(uidvalidity ?? '') + '\u0000' + uid)
  const bodyHash = sha256(canonicalText(text))
  return sha256('content\u0000' + accountId + '\u0000' + canonicalText(from) + '\u0000' + canonicalText(subject) + '\u0000' + canonicalText(date) + '\u0000' + bodyHash)
}

export function mailMessageRowId(accountId, dedupeKey) {
  return 'msg_' + sha256(accountId + '\u0000' + dedupeKey).slice(0, 32)
}

/**
 * Build one mail_messages row from parsed mail. Does not touch the database.
 * `status` defaults to 'new' when a body is retained, 'metadata' otherwise;
 * callers pass 'oversize' for header-only rows.
 */
export function buildMailMessageRow({
  accountId, mailbox = 'INBOX', uid = null, uidvalidity = null, sizeBytes = null,
  receivedAt, sentAt = null, from = '', subject = '', messageId = '', text = null,
  attachments = [], status = null, clientId = null, projectId = null, now,
} = {}) {
  if (typeof accountId !== 'string' || !accountId) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail message requires an account id')
  const received = normalizeIso(receivedAt, 'received-at')
  if (!received) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail message requires received-at')
  const sent = normalizeIso(sentAt, 'sent-at')
  const bodyText = text == null ? null : truncateUtf8(String(text), MAIL_MAX_BODY_BYTES)
  const retained = bodyText != null && bodyText.trim() !== ''
  const dedupeKey = mailDedupeKey({ accountId, mailbox, uidvalidity, uid, messageId, from, subject, date: sent ?? received, text: retained ? bodyText : '' })
  const at = isoOf(now)
  return {
    id: mailMessageRowId(accountId, dedupeKey),
    accountId,
    mailbox,
    uid: Number.isInteger(uid) && uid > 0 ? uid : null,
    uidvalidity: uidvalidity == null ? null : String(uidvalidity),
    messageId: normalizeMessageId(messageId) || null,
    dedupeKey,
    fromAddr: singleLine(from, MAIL_MAX_FROM_CHARS) || null,
    subject: singleLine(subject, MAIL_MAX_SUBJECT_CHARS) || null,
    sentAt: sent,
    receivedAt: received,
    sizeBytes: Number.isFinite(Number(sizeBytes)) && Number(sizeBytes) >= 0 ? Math.floor(Number(sizeBytes)) : null,
    bodyText: retained ? bodyText : null,
    bodySha256: retained ? sha256(bodyText) : null,
    attachments: normalizeAttachments(attachments),
    clientId: clientId ?? null,
    projectId: projectId ?? null,
    status: status ?? (retained ? 'new' : 'metadata'),
    candidateIds: [],
    purgedAt: null,
    createdAt: at,
    updatedAt: at,
  }
}

export function findMailMessageDuplicate(store, accountId, row) {
  const byKey = store.db.prepare('SELECT id, uid, dedupe_key FROM mail_messages WHERE account_id = ? AND dedupe_key = ? LIMIT 1').get(accountId, row.dedupeKey)
  if (byKey) return byKey
  if (Number.isInteger(row.uid) && row.uid > 0) {
    const byUid = store.db.prepare('SELECT id, uid, dedupe_key FROM mail_messages WHERE account_id = ? AND mailbox = ? AND uidvalidity IS ? AND uid = ? LIMIT 1').get(accountId, row.mailbox, row.uidvalidity, row.uid)
    if (byUid) return byUid
  }
  return undefined
}

/** Transaction-internal: insert one row; returns false when a unique index rejected it. */
export function insertMailMessage(store, row) {
  const info = store.db.prepare(
    'INSERT OR IGNORE INTO mail_messages(id,account_id,mailbox,uid,uidvalidity,message_id,dedupe_key,from_addr,subject,sent_at,received_at,size_bytes,body_text,body_sha256,attachments,client_id,project_id,status,candidate_ids,purged_at,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(row.id, row.accountId, row.mailbox, row.uid, row.uidvalidity, row.messageId, row.dedupeKey, row.fromAddr, row.subject, row.sentAt, row.receivedAt, row.sizeBytes, row.bodyText, row.bodySha256, JSON.stringify(row.attachments ?? []), row.clientId, row.projectId, row.status, JSON.stringify(row.candidateIds ?? []), row.purgedAt, row.createdAt, row.updatedAt)
  return Number(info.changes) > 0
}

const mapMessageRow = (row, { includeBody = false } = {}) => ({
  id: row.id,
  accountId: row.account_id,
  mailbox: row.mailbox,
  uid: Number(row.uid),
  uidvalidity: row.uidvalidity ?? undefined,
  messageId: row.message_id ?? undefined,
  dedupeKey: row.dedupe_key,
  from: row.from_addr ?? '',
  subject: row.subject ?? '',
  sentAt: row.sent_at ?? undefined,
  receivedAt: row.received_at,
  sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
  retained: row.body_text != null && row.purged_at == null,
  purgedAt: row.purged_at ?? undefined,
  bodySha256: row.body_sha256 ?? undefined,
  attachments: parseJson(row.attachments, []),
  clientId: row.client_id ?? undefined,
  projectId: row.project_id ?? undefined,
  status: row.status,
  candidateIds: parseJson(row.candidate_ids, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(includeBody ? { bodyText: row.body_text ?? null } : {}),
})

export function getMailMessage(store, ref, { includeBody = false } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) throw mailError(MAIL_ERROR_CODES.MESSAGE_NOT_FOUND, 'mail message id is required')
  const value = ref.trim()
  const stripped = normalizeMessageId(value) || value
  const row = value.startsWith('msg_')
    ? store.db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(value)
    : store.db.prepare('SELECT * FROM mail_messages WHERE message_id = ? ORDER BY received_at DESC LIMIT 1').get(stripped)
  if (!row) throw mailError(MAIL_ERROR_CODES.MESSAGE_NOT_FOUND, 'mail message not found: ' + value, 'run `advisers mail ls` to list messages')
  return mapMessageRow(row, { includeBody })
}

const MESSAGE_PATCHES = {
  status: 'status',
  clientId: 'client_id',
  projectId: 'project_id',
  bodyText: 'body_text',
  bodySha256: 'body_sha256',
  purgedAt: 'purged_at',
}

/** Transaction-internal: update one message row. */
export function updateMailMessage(store, id, patch = {}, { now } = {}) {
  const sets = []
  const values = []
  for (const [key, column] of Object.entries(MESSAGE_PATCHES)) {
    if (!(key in patch)) continue
    let value = patch[key]
    if (key === 'status') {
      if (!MAIL_MESSAGE_STATUSES.includes(value)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'unknown mail message status: ' + String(value))
    } else if (key === 'bodyText') {
      value = value == null ? null : truncateUtf8(String(value), MAIL_MAX_BODY_BYTES)
    }
    sets.push(column + ' = ?')
    values.push(value)
  }
  if ('candidateIds' in patch && Array.isArray(patch.candidateIds)) {
    sets.push('candidate_ids = ?')
    values.push(JSON.stringify([...new Set(patch.candidateIds.filter((candidateId) => typeof candidateId === 'string' && candidateId))]))
  }
  if (!sets.length) return getMailMessage(store, id)
  sets.push('updated_at = ?')
  values.push(isoOf(now))
  values.push(id)
  store.db.prepare('UPDATE mail_messages SET ' + sets.join(', ') + ' WHERE id = ?').run(...values)
  return getMailMessage(store, id)
}

/** Transaction-internal: append candidate ids to a message's reverse pointer. */
export function addMailCandidateIds(store, id, candidateIds, { now } = {}) {
  const current = store.db.prepare('SELECT candidate_ids FROM mail_messages WHERE id = ?').get(id)
  if (!current) return
  const merged = [...new Set([...parseJson(current.candidate_ids, []), ...candidateIds])]
  store.db.prepare('UPDATE mail_messages SET candidate_ids = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), isoOf(now), id)
}

function messageWhere(filters = {}) {
  const where = []
  const params = []
  if (filters.accountId) { where.push('account_id = ?'); params.push(filters.accountId) }
  if (filters.clientId) { where.push('client_id = ?'); params.push(filters.clientId) }
  if (filters.projectId) { where.push('project_id = ?'); params.push(filters.projectId) }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
    where.push('status IN (' + statuses.map(() => '?').join(',') + ')')
    params.push(...statuses)
  }
  if (filters.retained === true) where.push('body_text IS NOT NULL')
  if (filters.retained === false) where.push('body_text IS NULL')
  if (filters.sinceDays != null && Number(filters.sinceDays) >= 0) {
    const cutoff = new Date(nowDate(filters.now).getTime() - Number(filters.sinceDays) * DAY_MS).toISOString()
    where.push('received_at >= ?')
    params.push(cutoff)
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params }
}

/**
 * List message summaries (never the body). `newest first`, capped page.
 */
export function listMailMessages(store, filters = {}) {
  const limit = Math.max(1, Math.min(MAIL_MAX_LS_LIMIT, Number(filters.limit) || MAIL_DEFAULT_LS_LIMIT))
  const offset = Math.max(0, Math.floor(Number(filters.offset) || 0))
  const where = messageWhere(filters)
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM mail_messages' + where.sql).get(...where.params)?.n ?? 0)
  const rows = store.db.prepare('SELECT * FROM mail_messages' + where.sql + ' ORDER BY received_at DESC, uid DESC LIMIT ? OFFSET ?').all(...where.params, limit, offset)
  return { messages: rows.map((row) => mapMessageRow(row)), total, limit, offset, truncated: offset + rows.length < total }
}

/** Transaction-read: rows a `mail extract` run should scan (body retained). */
export function listMessagesForExtraction(store, { accountId, ids, all = false, limit = 20, now } = {}) {
  const cap = Math.max(1, Math.min(MAIL_MAX_SYNC_LIMIT, Number(limit) || 20))
  if (Array.isArray(ids) && ids.length) {
    const rows = []
    for (const ref of ids.slice(0, cap)) {
      const value = String(ref).trim()
      const stripped = normalizeMessageId(value) || value
      const row = value.startsWith('msg_')
        ? store.db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(value)
        : store.db.prepare('SELECT * FROM mail_messages WHERE message_id = ? ORDER BY received_at DESC LIMIT 1').get(stripped)
      if (row) rows.push(row)
    }
    return rows.map((row) => mapMessageRow(row, { includeBody: true }))
  }
  const statuses = all ? ['new', 'extracted', 'linked'] : ['new']
  const params = [...statuses]
  let sql = 'SELECT * FROM mail_messages WHERE body_text IS NOT NULL AND purged_at IS NULL AND status IN (' + statuses.map(() => '?').join(',') + ')'
  if (accountId) { sql += ' AND account_id = ?'; params.push(accountId) }
  sql += ' ORDER BY received_at ASC, uid ASC LIMIT ?'
  params.push(cap)
  return store.db.prepare(sql).all(...params).map((row) => mapMessageRow(row, { includeBody: true }))
}

/** Transaction-read: rows with a retained body, for retention/purge planning. */
export function listMessagesWithBody(store, { accountId, before } = {}) {
  const params = []
  let sql = 'SELECT * FROM mail_messages WHERE body_text IS NOT NULL AND purged_at IS NULL'
  if (accountId) { sql += ' AND account_id = ?'; params.push(accountId) }
  if (before) { sql += ' AND received_at < ?'; params.push(before) }
  sql += ' ORDER BY received_at ASC LIMIT 2000'
  return store.db.prepare(sql).all(...params).map((row) => mapMessageRow(row, { includeBody: true }))
}

/** Transaction-internal: clear retained bodies (metadata + body_sha256 stay). */
export function purgeMailBodies(store, ids, { now } = {}) {
  const at = isoOf(now)
  let purged = 0
  for (const id of ids) {
    const info = store.db.prepare('UPDATE mail_messages SET body_text = NULL, purged_at = ?, updated_at = ? WHERE id = ? AND body_text IS NOT NULL').run(at, at, id)
    purged += Number(info.changes)
  }
  return purged
}

export function nextLocalUid(store, accountId, mailbox = MAIL_LOCAL_MAILBOX) {
  const row = store.db.prepare('SELECT MAX(uid) AS max_uid FROM mail_messages WHERE account_id = ? AND mailbox = ?').get(accountId, mailbox)
  return Number(row?.max_uid ?? 0) + 1
}

/* ------------------------------------------------------------------ */
/* Sync runs + one-transaction batch apply                             */
/* ------------------------------------------------------------------ */

/** Transaction-internal: append one mail_sync_runs row. */
export function insertMailSyncRun(store, run = {}) {
  const id = run.id ?? randomId('sync_')
  store.db.prepare(
    'INSERT INTO mail_sync_runs(id,account_id,mailbox,started_at,finished_at,status,fetched,inserted,skipped,failed,uidvalidity,last_uid_before,last_uid_after,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, run.accountId, run.mailbox, run.startedAt, run.finishedAt, run.status ?? 'ok', Number(run.fetched) || 0, Number(run.inserted) || 0, Number(run.skipped) || 0, Number(run.failed) || 0, run.uidvalidity ?? null, run.lastUidBefore ?? null, run.lastUidAfter ?? null, run.errorCode ?? null)
  return id
}

/**
 * Transaction-internal: write a fetched batch, advance the cursor and record
 * the run in one BEGIN IMMEDIATE. The caller (lib/mail.js) performs the
 * network fetch BEFORE calling this, so no DB transaction is held across the
 * network.
 *
 * Cursor rule: never advance past a UID that failed to parse/fetch. On a
 * UIDVALIDITY change (only reachable with --full) the old UID space is
 * discarded instead of being carried over.
 */
export function applyMailSyncBatch(store, batch = {}) {
  const { accountId, mailbox, uidvalidity = null, messages = [], failedUids = [], uidnext = null, startedAt, now } = batch
  const at = isoOf(now)
  const failed = new Set((failedUids ?? []).filter((uid) => Number.isInteger(uid)))
  let inserted = 0
  let skipped = 0
  let duplicates = 0
  let maxCommittedUid = null
  for (const row of messages) {
    if (failed.has(row.uid)) continue
    row.uidvalidity = uidvalidity
    const duplicate = findMailMessageDuplicate(store, accountId, row)
    if (duplicate) {
      skipped += 1
      duplicates += 1
      if (Number.isInteger(row.uid)) maxCommittedUid = Math.max(maxCommittedUid ?? 0, row.uid)
      continue
    }
    if (insertMailMessage(store, row)) inserted += 1
    else { skipped += 1; duplicates += 1 }
    if (Number.isInteger(row.uid)) maxCommittedUid = Math.max(maxCommittedUid ?? 0, row.uid)
  }
  let advanceTo = maxCommittedUid
  if (failed.size) {
    const cap = Math.min(...failed) - 1
    advanceTo = cap < 1 ? null : advanceTo == null ? null : Math.min(advanceTo, cap)
  }
  const previous = batch.previousCursor
  const previousUidValidity = previous?.uidvalidity ?? null
  const previousLast = previous?.lastUid ?? null
  const uidvalidityChanged = Boolean(previousUidValidity != null && uidvalidity != null && String(previousUidValidity) !== String(uidvalidity))
  let lastUid
  if (uidvalidityChanged) {
    // The old UID space no longer exists: never carry the old cursor over.
    lastUid = advanceTo
  } else if (advanceTo == null) {
    lastUid = previousLast
  } else if (previousLast == null) {
    lastUid = advanceTo
  } else {
    lastUid = Math.max(previousLast, advanceTo)
  }
  putMailCursor(store, {
    accountId, mailbox,
    uidvalidity: uidvalidity ?? previousUidValidity,
    lastUid,
    uidnext,
    status: 'ok',
    now,
  })
  updateMailAccount(store, accountId, { lastSyncAt: at, lastError: null }, { now })
  insertMailSyncRun(store, {
    accountId, mailbox, startedAt: startedAt ?? at, finishedAt: at, status: 'ok',
    fetched: batch.fetched ?? messages.length + failed.size,
    inserted, skipped, failed: failed.size,
    uidvalidity: uidvalidity ?? previousUidValidity ?? null,
    lastUidBefore: previousLast,
    lastUidAfter: lastUid,
    errorCode: null,
  })
  return { inserted, skipped, duplicates, failed: failed.size, lastUidBefore: previousLast, lastUidAfter: lastUid, uidvalidityChanged }
}

/* ------------------------------------------------------------------ */
/* Retention / purge planning                                         */
/* ------------------------------------------------------------------ */

/**
 * Plan a retention purge: for every active account, bodies of messages older
 * than its retention window (or `olderThanDays` when given). Messages that
 * still have a pending memory candidate are skipped so an unreviewed
 * candidate can never lose its quote.
 */
export function planMailPurge(store, { now, olderThanDays, accountId } = {}) {
  const at = nowDate(now)
  const accounts = listMailAccounts(store).filter((account) => !accountId || account.id === accountId)
  const targets = []
  let skippedPending = 0
  let bytesFreed = 0
  for (const account of accounts) {
    const days = olderThanDays == null ? account.retentionDays : Number(olderThanDays)
    if (!Number.isFinite(days) || days < 0) continue
    if (olderThanDays == null && days === 0) continue // 0 = keep bodies until an explicit purge
    const cutoff = new Date(at.getTime() - days * DAY_MS).toISOString()
    const rows = listMessagesWithBody(store, { accountId: account.id, before: cutoff })
    for (const row of rows) {
      const pending = (row.candidateIds ?? []).some((candidateId) => store.getCandidate(candidateId)?.status === 'pending')
      if (pending) { skippedPending += 1; continue }
      const bytes = Buffer.byteLength(row.bodyText ?? '', 'utf8')
      bytesFreed += bytes
      targets.push({ id: row.id, accountId: row.accountId, bytes })
    }
  }
  return { targets, skippedPending, bytesFreed, accountsScanned: accounts.length }
}
