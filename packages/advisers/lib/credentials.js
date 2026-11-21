/**
 * IMAP credential storage for the 0.4.0 mail entry (lib/mail.js).
 *
 * Design (41-mail-entry.md §3.2, 总纲 §3):
 * - The password never enters SQLite, export/backup payloads, JSON output,
 *   argv, or logs. It lives in one JSON file per account:
 *     <ADVISERS_HOME>/credentials/imap/<account-id>.json
 * - Directory is created 0700, the file is written 0600 through the durable
 *   atomic writer (same-directory temp + fsync + rename), so a crash cannot
 *   leave a truncated credential file.
 * - A file whose POSIX mode grants group/other access is REFUSED on read
 *   (E_CREDENTIALS_INSECURE) instead of being silently trusted. Windows has no
 *   meaningful POSIX mode; there the user-profile ACL is the boundary and the
 *   check is skipped (documented in PRIVACY; this module never claims 0600
 *   protects the file on Windows).
 * - Reading a credential returns the secret; callers must only hand it to the
 *   IMAP login. No function in this module logs or stringifies the secret.
 *
 * The account id is restricted to a safe file-name alphabet so a crafted id
 * (e.g. '../x') can never escape the credentials directory.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync, rmWithRetrySync } from './fs-safe.js'
import { mailError, MAIL_ERROR_CODES } from './mail-errors.js'

export const IMAP_CREDENTIAL_FORMAT = 1
export const CREDENTIALS_DIR_NAME = 'credentials'
export const IMAP_DIR_NAME = 'imap'
export const MAX_ACCOUNT_ID_CHARS = 64
export const MAX_USER_CHARS = 320
export const MAX_PASS_CHARS = 4096

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WINDOWS = process.platform === 'win32'
const INSECURE_HINT = 'fix the permissions (chmod 700 <home>/credentials/imap and chmod 600 the .json file) and retry; advisers refuses to read a credential other local users can read'

/**
 * Resolve the Advisers home: explicit argument, ADVISERS_HOME, then ~/.advisers.
 * A provided-but-invalid home (number, empty string) is a hard error: silently
 * falling back to the real profile would write credentials to the wrong place.
 */
export function advisersHome(home) {
  if (home !== undefined && home !== null) {
    if (typeof home !== 'string' || !home.trim()) {
      throw mailError(MAIL_ERROR_CODES.CONFIG, 'ADVISERS_HOME must be a non-empty path string', 'pass the explicit home directory or set ADVISERS_HOME')
    }
    return home.trim()
  }
  const fromEnv = typeof process.env.ADVISERS_HOME === 'string' ? process.env.ADVISERS_HOME.trim() : ''
  if (fromEnv) return fromEnv
  return join(homedir(), '.advisers')
}

/** Reject ids that could escape the credentials directory or shadow a path. */
export function assertCredentialAccountId(accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId) || accountId.includes('..')) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'invalid mail account id for credential storage', 'account ids must match ' + ACCOUNT_ID_RE.source)
  }
  return accountId
}

/** <home>/credentials/imap (identity of the directory, not a promise it exists). */
export function imapCredentialsDir(home) {
  return join(advisersHome(home), CREDENTIALS_DIR_NAME, IMAP_DIR_NAME)
}

/** <home>/credentials/imap/<account-id>.json */
export function imapCredentialPath(accountId, { home } = {}) {
  const id = assertCredentialAccountId(accountId)
  return join(imapCredentialsDir(home), id + '.json')
}

function ensureCredentialsDir(home) {
  const dir = imapCredentialsDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!WINDOWS) {
    try { chmodSync(dir, 0o700) } catch {}
  }
  return dir
}

function normalizeSecret(value, field, max) {
  if (typeof value !== 'string') throw mailError(MAIL_ERROR_CODES.CONFIG, 'IMAP ' + field + ' must be a string')
  const text = value.replace(/[\u0000\r\n]/g, '')
  if (!text.trim()) throw mailError(MAIL_ERROR_CODES.CONFIG, 'IMAP ' + field + ' is required')
  if (text.length > max) throw mailError(MAIL_ERROR_CODES.CONFIG, 'IMAP ' + field + ' is longer than ' + max + ' characters')
  return text
}

function assertFileMode(file) {
  if (WINDOWS) return
  const stat = statSync(file)
  if ((stat.mode & 0o077) !== 0) {
    throw mailError(MAIL_ERROR_CODES.CREDENTIALS_INSECURE, 'the IMAP credential file grants access to group/other users', INSECURE_HINT)
  }
}

/**
 * Save (or replace) one IMAP credential atomically.
 *
 * @param {string} accountId stable mail account id (see lib/mail-store.js)
 * @param {{ user: string, pass: string }} credential
 * @param {{ home?: string, now?: Date }} [options]
 * @returns {{ accountId: string, path: string, user: string, updatedAt: string }}
 *          metadata only — never the password.
 */
export function saveImapCredential(accountId, credential = {}, { home, now } = {}) {
  const id = assertCredentialAccountId(accountId)
  const user = normalizeSecret(credential.user, 'user', MAX_USER_CHARS)
  const pass = normalizeSecret(credential.pass, 'password', MAX_PASS_CHARS)
  if (/[\u0000-\u001f\u007f]/.test(user)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'IMAP user contains control characters')
  const at = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString()
  const file = imapCredentialPath(id, { home })
  ensureCredentialsDir(home)
  const previous = readRawCredentialFile(file)
  const record = {
    format: IMAP_CREDENTIAL_FORMAT,
    accountId: id,
    user,
    pass,
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
  }
  atomicWriteFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
  if (!WINDOWS) {
    try { chmodSync(file, 0o600) } catch {}
    assertFileMode(file)
  }
  return { accountId: id, path: file, user, updatedAt: at }
}

function readRawCredentialFile(file) {
  let stat
  try { stat = lstatSync(file) } catch { return undefined }
  if (stat.isSymbolicLink()) {
    throw mailError(MAIL_ERROR_CODES.CREDENTIALS_INSECURE, 'the IMAP credential file is a symbolic link; refusing to follow it', 'replace it with a regular 0600 file')
  }
  assertFileMode(file)
  let record
  try { record = JSON.parse(readFileSync(file, 'utf8')) } catch {
    throw mailError(MAIL_ERROR_CODES.CREDENTIALS_INSECURE, 'the IMAP credential file is not valid JSON', 'delete it and run `advisers mail account add` again')
  }
  return record && typeof record === 'object' ? record : undefined
}

/**
 * Read one IMAP credential. Returns undefined when no file exists (callers map
 * that to E_MAIL_CREDENTIALS_MISSING with an actionable hint). Throws
 * E_CREDENTIALS_INSECURE for a symlink, loose permissions or corrupt JSON.
 *
 * @returns {{ accountId: string, user: string, pass: string, updatedAt?: string } | undefined}
 */
export function readImapCredential(accountId, { home } = {}) {
  const id = assertCredentialAccountId(accountId)
  const file = imapCredentialPath(id, { home })
  if (!existsSync(file)) return undefined
  const record = readRawCredentialFile(file)
  if (!record || record.format !== IMAP_CREDENTIAL_FORMAT || record.accountId !== id) {
    throw mailError(MAIL_ERROR_CODES.CREDENTIALS_INSECURE, 'the IMAP credential file has an unsupported format', 'delete it and run `advisers mail account add` again')
  }
  if (typeof record.user !== 'string' || !record.user || typeof record.pass !== 'string' || !record.pass) {
    throw mailError(MAIL_ERROR_CODES.CREDENTIALS_INSECURE, 'the IMAP credential file is incomplete', 'delete it and run `advisers mail account add` again')
  }
  return { accountId: id, user: record.user, pass: record.pass, updatedAt: record.updatedAt }
}

/** True when a credential file exists (no secret is read). */
export function hasImapCredential(accountId, { home } = {}) {
  try { return existsSync(imapCredentialPath(accountId, { home })) } catch { return false }
}

/** Remove one credential file. Returns true when a file was removed. */
export function removeImapCredential(accountId, { home } = {}) {
  const file = imapCredentialPath(accountId, { home })
  if (!existsSync(file)) return false
  rmWithRetrySync(file, { force: true })
  return true
}

/** Account ids that currently have a stored credential (sorted). */
export function listImapCredentialAccountIds({ home } = {}) {
  const dir = imapCredentialsDir(home)
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const ids = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!ACCOUNT_ID_RE.test(id) || id.includes('..')) continue
    ids.push(id)
  }
  return ids.sort()
}
