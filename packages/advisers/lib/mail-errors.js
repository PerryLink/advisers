/**
 * 0.4.0 mail-entry error helpers.
 *
 * Every failure in lib/mail*.js and lib/credentials.js is an Error with a stable
 * `code` (the mail/IMAP/credential codes below), an optional `hint`,
 * and a message that never contains a password or email body text. The new
 * codes are registered in lib/error-codes.js at integration time (see the 0.4
 * implementation report).
 *
 * This module is pure (no I/O, no network, no console).
 */

/** All mail/IMAP/credential codes this feature can raise. */
export const MAIL_ERROR_CODES = Object.freeze({
  CONFIG: 'E_MAIL_CONFIG',
  ACCOUNT_NOT_FOUND: 'E_MAIL_ACCOUNT_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'E_MAIL_MESSAGE_NOT_FOUND',
  CREDENTIALS_MISSING: 'E_MAIL_CREDENTIALS_MISSING',
  CREDENTIALS_INSECURE: 'E_CREDENTIALS_INSECURE',
  IMAP_AUTH: 'E_IMAP_AUTH',
  IMAP_TLS: 'E_IMAP_TLS',
  IMAP_UIDVALIDITY: 'E_IMAP_UIDVALIDITY',
  IMAP_PROTOCOL: 'E_IMAP_PROTOCOL',
  IMAP_TIMEOUT: 'E_IMAP_TIMEOUT',
  MAIL_TOO_LARGE: 'E_MAIL_TOO_LARGE',
  NOT_RETAINED: 'E_MAIL_NOT_RETAINED',
  MODEL_DISABLED: 'E_MAIL_MODEL_DISABLED',
  // Reuses the existing ledger schema code: mail needs the v22 tables.
  SCHEMA_STALE: 'E_SCHEMA_STALE',
})

const KNOWN = new Set(Object.values(MAIL_ERROR_CODES))

/** A business error with a stable code (message keeps the code for stderr). */
export function mailError(code, message, hint) {
  if (!KNOWN.has(code)) throw new TypeError('unknown mail error code: ' + String(code))
  const error = new Error(code + ': ' + message + (hint ? ' (hint: ' + hint + ')' : ''))
  error.code = code
  if (hint) error.hint = hint
  return error
}

/** True when `error` is one of this feature's coded errors. */
export function isMailError(error) {
  return Boolean(error && typeof error === 'object' && KNOWN.has(error.code))
}
