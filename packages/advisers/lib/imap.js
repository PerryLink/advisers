/**
 * E2-T2: minimal read-only IMAP client.
 *
 * Only LOGIN, EXAMINE, UID SEARCH, UID FETCH (BODY.PEEK[]) and LOGOUT are ever
 * sent. There is no STORE/APPEND/EXPUNGE/COPY/MOVE path; the mailbox is opened
 * with EXAMINE (read-only) by design.
 *
 * The client is intentionally tiny: no OAuth flow, no Gmail API, no cloud SDK.
 * Credentials come from the caller (env in the CLI), are never written to disk
 * and never logged.
 *
 * Robustness (2026-11-17 audit P1-9): one managed inactivity timer instead of a
 * new socket.setTimeout listener per read, a total request deadline, a literal
 * size cap, and the real server UID (parsed from the FETCH UID attribute)
 * instead of the message sequence number.
 */
import net from 'node:net'
import tls from 'node:tls'
// 0.3.0 Wave 3 (docs/TUI.md §4): the server greeting and tagged status lines are
// remote text. They must never reach stderr with ANSI/OSC/bidi or a second line,
// so every message that embeds one is sanitised here (bin only prefixes it).
import { sanitizeConsoleText } from './text-safe.js'

const CRLF = '\r\n'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_LITERAL_BYTES = 25 * 1024 * 1024

export function imapQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export function imapSinceDate(days = 30, now = new Date()) {
  const d = new Date(now.getTime() - Math.max(0, days) * 86_400_000)
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

function createReader(socket, { idleTimeoutMs = DEFAULT_TIMEOUT_MS, deadline = Number.POSITIVE_INFINITY, totalTimeoutMs = DEFAULT_TIMEOUT_MS, maxLiteralBytes = MAX_LITERAL_BYTES } = {}) {
  let buffer = Buffer.alloc(0)
  let ended = false
  let error
  let wake = null
  let timer = null

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }
  const wakeUp = () => {
    clearTimer()
    if (wake) { const w = wake; wake = null; w() }
  }
  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); wakeUp() })
  socket.on('end', () => { ended = true; wakeUp() })
  socket.on('error', (e) => { error = e; wakeUp() })

  const waitData = () => new Promise((resolve) => {
    if (buffer.length || ended || error) return resolve()
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      error = new Error(`IMAP request timed out after ${totalTimeoutMs}ms`)
      return resolve()
    }
    wake = resolve
    const waitMs = Math.max(1, Math.min(idleTimeoutMs, remaining))
    timer = setTimeout(() => {
      timer = null
      error = remaining <= idleTimeoutMs
        ? new Error(`IMAP request timed out after ${totalTimeoutMs}ms`)
        : new Error(`IMAP connection idle for more than ${idleTimeoutMs}ms`)
      wakeUp()
    }, waitMs)
  })

  async function readLine() {
    for (;;) {
      const idx = buffer.indexOf('\r\n')
      if (idx >= 0) { const line = buffer.subarray(0, idx).toString('latin1'); buffer = buffer.subarray(idx + 2); return line }
      if (error) throw error
      if (ended) throw new Error('IMAP connection ended before a complete line')
      await waitData()
    }
  }
  async function readBytes(n) {
    if (n > maxLiteralBytes) throw new Error(`IMAP literal is larger than the ${maxLiteralBytes}-byte limit`)
    while (buffer.length < n) {
      if (error) throw error
      if (ended) throw new Error('IMAP connection ended inside a literal')
      await waitData()
    }
    const data = buffer.subarray(0, n); buffer = buffer.subarray(n); return data
  }
  async function response(tag) {
    const untagged = []
    const literals = []
    for (;;) {
      const line = await readLine()
      if (line.startsWith(tag + ' ')) return { untagged, literals, status: line }
      const m = /\{(\d+)\}$/.exec(line)
      untagged.push(line)
      if (m) {
        const size = Number(m[1])
        if (size > maxLiteralBytes) throw new Error(`IMAP literal is larger than the ${maxLiteralBytes}-byte limit`)
        literals.push(await readBytes(size))
      }
    }
  }
  return { readLine, response, clearTimer }
}

export async function fetchImapMessages({
  host, port = 993, secure = true, user, pass, mailbox = 'INBOX', sinceDays = 30, limit = 20,
  rejectUnauthorized = true, connect, timeoutMs = DEFAULT_TIMEOUT_MS, idleTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxLiteralBytes = MAX_LITERAL_BYTES,
} = {}) {
  if (!host || !user || !pass) throw new Error('IMAP host/user/password are required')
  const socket = await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { s?.destroy?.() } catch {}
      reject(new Error(`IMAP connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const onError = (e) => finish(reject, e)
    let s
    try {
      s = connect ? connect({ host, port, secure }) : secure ? tls.connect({ host, port, rejectUnauthorized }) : net.connect({ host, port })
    } catch (error) {
      finish(reject, error)
      return
    }
    if (typeof s.then === 'function') {
      s.then((x) => finish(resolve, x), (e) => finish(reject, e))
      return
    }
    s.once('error', onError)
    s.once(secure ? 'secureConnect' : 'connect', () => {
      s.off?.('error', onError)
      finish(resolve, s)
    })
  })
  const reader = createReader(socket, { idleTimeoutMs, totalTimeoutMs: timeoutMs, deadline: Date.now() + timeoutMs, maxLiteralBytes })
  let tagNo = 0
  const tag = () => 'A' + (++tagNo)
  const command = async (text) => {
    const t = tag()
    socket.write(`${t} ${text}${CRLF}`)
    const r = await reader.response(t)
    if (!/^OK/i.test(r.status.split(' ').slice(1).join(' '))) throw new Error(`IMAP ${text.split(' ')[0]} failed: ${sanitizeConsoleText(r.status, { max: 500 })}`)
    return r
  }
  try {
    const greeting = await reader.readLine()
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error(`IMAP greeting failed: ${sanitizeConsoleText(greeting, { max: 500 })}`)
    await command(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`)
    const selected = await command(`EXAMINE ${imapQuote(mailbox)}`)
    const exists = selected.untagged.find((l) => /^\* \d+ EXISTS/i.test(l))
    if (!exists) throw new Error('IMAP EXAMINE did not return EXISTS')
    const search = await command(`UID SEARCH SINCE ${imapSinceDate(sinceDays)}`)
    const searchLine = search.untagged.find((l) => /^\* SEARCH/i.test(l)) ?? ''
    const uids = searchLine.split(/\s+/).slice(2).filter((x) => /^\d+$/.test(x)).map(Number)
    const wanted = uids.slice(-Math.max(0, limit))
    let messages = []
    if (wanted.length) {
      const fetched = await command(`UID FETCH ${wanted.join(',')} (UID BODY.PEEK[])`)
      const fetchLines = fetched.untagged.filter((l) => /^\* \d+ FETCH/i.test(l))
      messages = fetched.literals.map((raw, index) => {
        const uidMatch = /\bUID (\d+)\b/i.exec(fetchLines[index] ?? '')
        return { uid: uidMatch ? Number(uidMatch[1]) : null, raw }
      })
    }
    await command('LOGOUT').catch(() => {})
    return messages
  } finally {
    reader.clearTimer()
    try { socket.end() } catch {}
    try { socket.destroy?.() } catch {}
  }
}
