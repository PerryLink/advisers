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
import { localDay } from './remind.js'

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
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 200)}`)))
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

function truncateDetail(value, limit = 200) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > limit ? text.slice(0, limit) : text
}

/**
 * Opt-in outbound webhook: POST the sanitized summary as JSON.
 *
 * Disabled unless `ADVISERS_NOTIFY_WEBHOOK` (or an explicit `url`) is set. The
 * function never throws for network/config failures; it returns a structured
 * result so the caller can fall back to the local log:
 *
 *   { sent: true,  channel: 'webhook', configured: true, status, payload }
 *   { sent: false, channel: 'webhook', configured: false, reason: 'not-configured' }
 *   { sent: false, channel: 'webhook', configured: true, error: 'network'|'timeout'|'http'|'invalid-url'|'unsupported-protocol', status?, detail? }
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
  try {
    const response = await fetchImpl(target.url.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'advisers-webhook/1' },
      body: JSON.stringify(summary),
      signal,
    })
    if (!response || typeof response !== 'object') {
      return { sent: false, channel: 'webhook', configured: true, error: 'network', detail: 'empty response' }
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
      }
    }
    return { sent: true, channel: 'webhook', configured: true, status: response.status, payload: summary }
  } catch (error) {
    const name = String(error?.name ?? '')
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { sent: false, channel: 'webhook', configured: true, error: 'timeout', detail: `no response within ${timeoutMs}ms` }
    }
    return {
      sent: false,
      channel: 'webhook',
      configured: true,
      error: 'network',
      detail: truncateDetail(error?.message ?? error),
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
