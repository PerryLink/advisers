/**
 * E1-T3: best-effort local notification adapter.
 *
 * No implicit cloud push. The caller decides the body; Advisers only sends a
 * short count-style body (not client names/quotes). If no local channel is
 * available the caller keeps the local reminder log; this module reports
 * `sent:false`. The only outbound channel is the explicit, off-by-default
 * `ADVISERS_NOTIFY_WEBHOOK` adapter below, which sends counts/levels/dates only.
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { localDay } from './remind.js'
// 0.3.0 Wave 3 (docs/TUI.md §4): webhook/notifier failure detail is remote text
// and reaches stderr through bin's `webhook 未发送:` line. Sanitise at the library
// boundary so no caller can leak ANSI/C1/bidi or a second log line.
import { sanitizeConsoleText } from './text-safe.js'

/**
 * Environment for the notification subprocess: an explicit allowlist.
 *
 * The command is a local third-party program (custom notifier, osascript,
 * notify-send, powershell). Inheriting process.env would hand it every Advisers
 * secret — ADVISERS_API_KEY, ADVISERS_AUDIT_KEY (the audit HMAC key),
 * vault/sync/export passphrases and provider URLs (security audit SEC2-03,
 * 2026-11-17). Only OS/runtime basics needed to start a program are passed
 * through; credentials never are.
 */
const ADAPTER_ENV_KEYS = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'windir',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'PSModulePath',
])

function adapterEnv(source = process.env) {
  const env = {}
  for (const key of ADAPTER_ENV_KEYS) {
    const value = source?.[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  return env
}

function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, windowsHide: true, env: adapterEnv() })
    let err = ''
    child.stderr.on('data', (b) => { err += b.toString('utf8') })
    child.on('error', reject)
    // A local notifier's stderr is untrusted text (it may include the reminder
    // title the caller passed); keep it to one sanitised line.
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${sanitizeConsoleText(err.trim(), { max: 200 })}`)))
  })
}

function powershellToastScript(title, body) {
  const q = (s) => String(s).replace(/'/g, "''")
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n = $t.GetElementsByTagName('text')",
    `$n.Item(0).AppendChild($t.CreateTextNode('${q(title)}')) | Out-Null`,
    `$n.Item(1).AppendChild($t.CreateTextNode('${q(body)}')) | Out-Null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Advisers').Show($toast)",
  ].join('; ')
}


/** Env var that opts a machine into the outbound JSON webhook (off by default). */
export const WEBHOOK_ENV = 'ADVISERS_NOTIFY_WEBHOOK'
/** Versioned payload schema; consumers can reject unknown versions. */
export const WEBHOOK_SCHEMA = 'advisers.notify.webhook.v1'
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000
const MAX_WEBHOOK_DATES = 31

export function isWebhookConfigured(env = process.env) {
  return String(env?.[WEBHOOK_ENV] ?? '').trim() !== ''
}

/** Env var holding the Standard Webhooks signing secret (`whsec_<base64>`). */
export const WEBHOOK_SECRET_ENV = 'ADVISERS_NOTIFY_WEBHOOK_SECRET'
/** Standard Webhooks signature version this adapter emits. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1'
/** Replay window: |now - webhook-timestamp| must be <= this many seconds. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300
export const WEBHOOK_ID_HEADER = 'webhook-id'
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp'
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature'

function toWebhookBody(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('webhook body must be a string or Buffer')
}

function normalizeWebhookId(id) {
  const text = typeof id === 'string' ? id.trim() : String(id ?? '').trim()
  if (!text) throw new TypeError('webhook id must not be empty')
  if (/[\r\n\0]/.test(text)) throw new TypeError('webhook id must be single-line')
  return text
}

function normalizeWebhookTimestamp(timestamp) {
  const value = typeof timestamp === 'string' ? Number(timestamp.trim()) : timestamp
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('webhook timestamp must be integer unix seconds')
  return value
}

function resolveNowMs(now) {
  if (now === undefined || now === null) return Date.now()
  const date = now instanceof Date ? now : new Date(now)
  const ms = date.getTime()
  if (!Number.isFinite(ms)) throw new RangeError('invalid webhook now: ' + String(now))
  return ms
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value === undefined || value === null ? undefined : String(value)
  }
  if (headers instanceof Map) {
    for (const [key, value] of headers) if (String(key).toLowerCase() === name) return value === undefined || value === null ? undefined : String(value)
    return undefined
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const value = headers[key]
    if (Array.isArray(value)) return value.length ? String(value[0]) : undefined
    return value === undefined || value === null ? undefined : String(value)
  }
  return undefined
}

/**
 * Decode a Standard Webhooks secret. `whsec_<base64>` yields the decoded key
 * bytes; any other non-empty string is used as UTF-8 key material (convenience
 * for self-hosted receivers). Returns null for empty/invalid input — never
 * throws and never logs the value.
 *
 * @param {string|null|undefined} secret
 * @returns {Buffer|null}
 */
export function parseWebhookSecret(secret) {
  if (typeof secret !== 'string') return null
  const text = secret.trim()
  if (!text) return null
  if (!text.startsWith('whsec_')) return Buffer.from(text, 'utf8')
  const encoded = text.slice('whsec_'.length).trim()
  if (!encoded) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  const decoded = Buffer.from(encoded, 'base64')
  if (!decoded.length) return null
  if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return null
  return decoded
}

/** True when the configured webhook would be signed (a valid secret exists). */
export function isWebhookSigningConfigured(env = process.env) {
  return parseWebhookSecret(env?.[WEBHOOK_SECRET_ENV]) !== null
}

function signWithKey(key, { id, timestamp, body }) {
  const messageId = normalizeWebhookId(id)
  const seconds = normalizeWebhookTimestamp(timestamp)
  const payload = toWebhookBody(body)
  const signedContent = Buffer.concat([Buffer.from(messageId + '.' + seconds + '.', 'utf8'), payload])
  const digest = createHmac('sha256', key).update(signedContent).digest('base64')
  return WEBHOOK_SIGNATURE_VERSION + ',' + digest
}

/**
 * `webhook-signature` header value: `v1,base64(HMAC-SHA256(secret, id.timestamp.body))`.
 * Pure and deterministic; throws TypeError on an invalid secret/id/timestamp.
 *
 * @param {string} secret
 * @param {{id: string, timestamp: number|string, body: string|Buffer}} options
 * @returns {string}
 */
export function signWebhook(secret, options = {}) {
  const key = parseWebhookSecret(secret)
  if (!key) throw new TypeError('invalid webhook secret')
  return signWithKey(key, options ?? {})
}

/**
 * The three Standard Webhooks request headers. `timestamp` defaults to the
 * injected `now` (or the clock); `id` defaults to a random UUID.
 *
 * @param {{secret: string, id?: string, timestamp?: number|string,
 *   body: string|Buffer, now?: Date|string|number}} options
 * @returns {Record<string, string>}
 */
export function buildWebhookHeaders({ secret, id, timestamp, body, now } = {}) {
  const key = parseWebhookSecret(secret)
  if (!key) throw new TypeError('invalid webhook secret')
  const messageId = id === undefined ? randomUUID() : normalizeWebhookId(id)
  const seconds = timestamp === undefined ? Math.floor(resolveNowMs(now) / 1000) : normalizeWebhookTimestamp(timestamp)
  return {
    [WEBHOOK_ID_HEADER]: messageId,
    [WEBHOOK_TIMESTAMP_HEADER]: String(seconds),
    [WEBHOOK_SIGNATURE_HEADER]: signWithKey(key, { id: messageId, timestamp: seconds, body }),
  }
}

/**
 * Stateless receiver-side verifier for Standard Webhooks deliveries.
 *
 * Checks header presence, the +/- `toleranceSeconds` timestamp window and the
 * HMAC in constant time. Returns structured results (never throws for a bad
 * delivery):
 *
 *   { valid: true, id, timestamp, version }
 *   { valid: false, reason: 'missing-header'|'invalid-id'|'invalid-timestamp'|
 *     'timestamp-out-of-window'|'invalid-signature'|'invalid-secret', ... }
 *
 * `webhook-id` is the idempotency key: pair this with
 * {@link createWebhookReplayGuard} to reject replays inside the window.
 */
export function verifyWebhookSignature({ secret, headers, body, now, toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } = {}) {
  const key = parseWebhookSecret(secret)
  if (!key) return { valid: false, reason: 'invalid-secret' }
  const id = headerValue(headers, WEBHOOK_ID_HEADER)
  const timestampHeader = headerValue(headers, WEBHOOK_TIMESTAMP_HEADER)
  const signatureHeader = headerValue(headers, WEBHOOK_SIGNATURE_HEADER)
  const missing = []
  if (!id) missing.push(WEBHOOK_ID_HEADER)
  if (!timestampHeader) missing.push(WEBHOOK_TIMESTAMP_HEADER)
  if (!signatureHeader) missing.push(WEBHOOK_SIGNATURE_HEADER)
  if (missing.length) return { valid: false, reason: 'missing-header', missing }
  if (/[\r\n\0]/.test(id)) return { valid: false, reason: 'invalid-id' }
  if (!/^\d+$/.test(timestampHeader.trim())) return { valid: false, reason: 'invalid-timestamp' }
  const seconds = Number(timestampHeader.trim())
  if (!Number.isSafeInteger(seconds)) return { valid: false, reason: 'invalid-timestamp' }
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0) throw new RangeError('toleranceSeconds must be a non-negative integer')
  const nowSeconds = Math.floor(resolveNowMs(now) / 1000)
  if (Math.abs(nowSeconds - seconds) > toleranceSeconds) return { valid: false, reason: 'timestamp-out-of-window', timestamp: seconds }
  const payload = toWebhookBody(body)
  const signedContent = Buffer.concat([Buffer.from(id + '.' + seconds + '.', 'utf8'), payload])
  const expected = createHmac('sha256', key).update(signedContent).digest()
  for (const candidate of signatureHeader.split(/\s+/).filter(Boolean)) {
    const separator = candidate.indexOf(',')
    if (separator <= 0) continue
    if (candidate.slice(0, separator) !== WEBHOOK_SIGNATURE_VERSION) continue
    const provided = Buffer.from(candidate.slice(separator + 1), 'base64')
    if (provided.length !== expected.length) continue
    if (timingSafeEqual(provided, expected)) return { valid: true, id, timestamp: seconds, version: WEBHOOK_SIGNATURE_VERSION }
  }
  return { valid: false, reason: 'invalid-signature' }
}

/**
 * In-memory idempotency cache for receivers: rejects a `webhook-id` seen before
 * (replay), a timestamp outside the +/- tolerance window, and stale entries are
 * evicted automatically. `verify()` composes the signature check with the replay
 * check; `check()` only inspects id/timestamp.
 *
 * The cache is deliberately process-local and bounded: it is a convenience for
 * the documented verifier snippet, not a durable outbox.
 */
export function createWebhookReplayGuard({ toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, maxEntries = 1000 } = {}) {
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0) throw new RangeError('toleranceSeconds must be a non-negative integer')
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer')
  const seen = new Map()
  function prune(nowSeconds) {
    for (const [id, timestamp] of seen) if (nowSeconds - timestamp > toleranceSeconds) seen.delete(id)
    while (seen.size > maxEntries) { const oldest = seen.keys().next().value; seen.delete(oldest) }
  }
  function check({ id, timestamp, now } = {}) {
    const messageId = normalizeWebhookId(id)
    const seconds = normalizeWebhookTimestamp(timestamp)
    const nowSeconds = Math.floor(resolveNowMs(now) / 1000)
    if (Math.abs(nowSeconds - seconds) > toleranceSeconds) return { accepted: false, reason: 'timestamp-out-of-window' }
    prune(nowSeconds)
    if (seen.has(messageId)) return { accepted: false, reason: 'replay' }
    seen.set(messageId, seconds)
    return { accepted: true }
  }
  function verify({ secret, headers, body, now } = {}) {
    const result = verifyWebhookSignature({ secret, headers, body, now, toleranceSeconds })
    if (!result.valid) return result
    const replay = check({ id: result.id, timestamp: result.timestamp, now })
    if (!replay.accepted) return { valid: false, reason: replay.reason }
    return result
  }
  return { check, verify, size: () => seen.size }
}

/**
 * Reduce due reminders to the only data allowed to leave the machine: a count,
 * per-level counts and the affected local dates. Titles, creditors, actions,
 * evidence and quotes are never read.
 */
export function summarizeReminders(reminders) {
  if (!Array.isArray(reminders)) throw new TypeError('summarizeReminders requires an array of reminders')
  const levels = { L1: 0, L2: 0, L3: 0 }
  const dates = new Set()
  let count = 0
  for (const reminder of reminders) {
    if (!reminder || typeof reminder !== 'object') continue
    count += 1
    if (reminder.level === 'L1' || reminder.level === 'L2' || reminder.level === 'L3') levels[reminder.level] += 1
    const day = localDay(reminder.dueAt)
    if (day) dates.add(day)
  }
  return {
    schema: WEBHOOK_SCHEMA,
    count,
    levels,
    dates: [...dates].sort().slice(0, MAX_WEBHOOK_DATES),
  }
}

function resolveWebhookTarget(options) {
  const raw = options.url === undefined ? process.env[WEBHOOK_ENV] : options.url
  if (raw == null || String(raw).trim() === '') return { configured: false }
  try {
    const url = new URL(String(raw).trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { configured: true, error: 'unsupported-protocol' }
    return { configured: true, url }
  } catch {
    return { configured: true, error: 'invalid-url' }
  }
}

/**
 * One sanitised console line for a remote failure detail (webhook response body,
 * fetch/abort message). ANSI/OSC/C1/bidi and line breaks are removed before the
 * value can reach stderr, and the result is capped at `limit` code points.
 */
function truncateDetail(value, limit = 200) {
  return sanitizeConsoleText(value, { max: limit })
}

/**
 * Opt-in outbound webhook: POST the sanitized summary as JSON.
 *
 * Disabled unless `ADVISERS_NOTIFY_WEBHOOK` (or an explicit `url`) is set. The
 * function never throws for network/config failures; it returns a structured
 * result so the caller can fall back to the local log:
 *
 *   { sent: true,  channel: 'webhook', configured: true, status, payload,
 *     signing: 'standard-webhooks'|'none', warning?: 'missing-secret',
 *     webhookId?, webhookTimestamp? }
 *   { sent: false, channel: 'webhook', configured: false, reason: 'not-configured' }
 *   { sent: false, channel: 'webhook', configured: true, error: 'network'|'timeout'|'http'|
 *     'invalid-url'|'unsupported-protocol'|'invalid-secret'|'invalid-options'|'fetch-unavailable',
 *     status?, detail?, signing? }
 *
 * Proactive 0.4 adds Standard Webhooks headers (`webhook-id`/`webhook-timestamp`/
 * `webhook-signature`) when `ADVISERS_NOTIFY_WEBHOOK_SECRET` (or `options.secret`)
 * is present; the JSON payload itself is byte-identical to 0.3.2. A configured
 * webhook without a secret still delivers unsigned (`signing:'none'`,
 * `warning:'missing-secret'`) for backward compatibility; an invalid secret is a
 * structured `invalid-secret` failure and nothing is sent.
 */
export async function sendWebhookNotification(reminders, options = {}) {
  const opts = options ?? {}
  const summary = summarizeReminders(reminders)
  const target = resolveWebhookTarget(opts)
  if (!target.configured) {
    return { sent: false, channel: 'webhook', configured: false, reason: 'not-configured' }
  }
  if (target.error) {
    return { sent: false, channel: 'webhook', configured: true, error: target.error }
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { sent: false, channel: 'webhook', configured: true, error: 'fetch-unavailable' }
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_WEBHOOK_TIMEOUT_MS
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  // The payload bytes are unchanged from 0.3.2: the signature covers exactly the
  // body that goes over the wire, and only request headers are added.
  const body = JSON.stringify(summary)
  const configuredSecret = opts.secret === undefined ? process.env?.[WEBHOOK_SECRET_ENV] : opts.secret
  let signing = 'none'
  let warning
  let webhookId
  let webhookTimestamp
  let requestHeaders = { 'content-type': 'application/json', 'user-agent': 'advisers-webhook/1' }
  if (configuredSecret !== undefined && configuredSecret !== null && String(configuredSecret).trim() !== '') {
    const key = parseWebhookSecret(configuredSecret)
    if (!key) return { sent: false, channel: 'webhook', configured: true, error: 'invalid-secret' }
    try {
      const id = opts.id === undefined ? randomUUID() : normalizeWebhookId(opts.id)
      const seconds = opts.timestamp === undefined ? Math.floor(resolveNowMs(opts.now) / 1000) : normalizeWebhookTimestamp(opts.timestamp)
      requestHeaders = {
        ...requestHeaders,
        [WEBHOOK_ID_HEADER]: id,
        [WEBHOOK_TIMESTAMP_HEADER]: String(seconds),
        [WEBHOOK_SIGNATURE_HEADER]: signWithKey(key, { id, timestamp: seconds, body }),
      }
      webhookId = id
      webhookTimestamp = seconds
      signing = 'standard-webhooks'
    } catch (error) {
      return { sent: false, channel: 'webhook', configured: true, error: 'invalid-options', detail: truncateDetail(error?.message ?? error) }
    }
  } else {
    // Backward compatible: a configured webhook still delivers unsigned, but the
    // result says so; the CLI prints one warning and status records signing=none.
    warning = 'missing-secret'
  }
  const signingMeta = { signing, ...(warning ? { warning } : {}), ...(webhookId ? { webhookId, webhookTimestamp } : {}) }
  try {
    const response = await fetchImpl(target.url.href, {
      method: 'POST',
      headers: requestHeaders,
      body,
      signal,
    })
    if (!response || typeof response !== 'object') {
      return { sent: false, channel: 'webhook', configured: true, error: 'network', detail: 'empty response', ...signingMeta }
    }
    if (!response.ok) {
      let detail
      try {
        detail = truncateDetail(await response.text())
      } catch {
        detail = undefined
      }
      return {
        sent: false,
        channel: 'webhook',
        configured: true,
        error: 'http',
        status: response.status,
        ...(detail ? { detail } : {}),
        ...signingMeta,
      }
    }
    return { sent: true, channel: 'webhook', configured: true, status: response.status, payload: summary, ...signingMeta }
  } catch (error) {
    const name = String(error?.name ?? '')
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { sent: false, channel: 'webhook', configured: true, error: 'timeout', detail: `no response within ${timeoutMs}ms`, ...signingMeta }
    }
    return {
      sent: false,
      channel: 'webhook',
      configured: true,
      error: 'network',
      detail: truncateDetail(error?.message ?? error),
      ...signingMeta,
    }
  }
}

export async function sendNotification({ title = 'Advisers', body = '', cmd = process.env.ADVISERS_NOTIFY_CMD } = {}) {
  if (cmd) {
    await run(cmd, [title, body])
    return { sent: true, channel: 'custom' }
  }
  const platform = process.platform
  try {
    if (platform === 'darwin') {
      await run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])
      return { sent: true, channel: 'osascript' }
    }
    if (platform === 'linux') {
      if (process.env.WSL_DISTRO_NAME && existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')) {
        await run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellToastScript(title, body)])
        return { sent: true, channel: 'wsl-toast' }
      }
      const candidates = ['/usr/bin/notify-send', '/bin/notify-send']
      const found = candidates.find((p) => existsSync(p))
      if (found) { await run(found, [title, body]); return { sent: true, channel: 'notify-send' } }
      return { sent: false, channel: 'none' }
    }
    if (platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellToastScript(title, body)])
      return { sent: true, channel: 'windows-toast' }
    }
    return { sent: false, channel: 'none' }
  } catch {
    return { sent: false, channel: 'error' }
  }
}
