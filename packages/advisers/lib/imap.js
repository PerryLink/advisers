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
 */
import net from 'node:net'
import tls from 'node:tls'

const CRLF = '\r\n'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function imapQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export function imapSinceDate(days = 30, now = new Date()) {
  const d = new Date(now.getTime() - Math.max(0, days) * 86_400_000)
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

function createReader(socket) {
  let buffer = Buffer.alloc(0)
  let ended = false
  let error
  let wake = null
  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); if (wake) { const w = wake; wake = null; w() } })
  socket.on('end', () => { ended = true; if (wake) { const w = wake; wake = null; w() } })
  socket.on('error', (e) => { error = e; if (wake) { const w = wake; wake = null; w() } })
  const waitData = () => new Promise((resolve) => {
    if (buffer.length || ended || error) return resolve()
    wake = resolve
    socket.setTimeout?.(30_000, () => { error = new Error('IMAP socket timeout'); wake?.(); wake = null })
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
      if (m) literals.push(await readBytes(Number(m[1])))
    }
  }
  return { readLine, response }
}

export async function fetchImapMessages({
  host, port = 993, secure = true, user, pass, mailbox = 'INBOX', sinceDays = 30, limit = 20,
  rejectUnauthorized = true, connect, timeoutMs = 30_000,
} = {}) {
  if (!host || !user || !pass) throw new Error('IMAP host/user/password are required')
  if (typeof fetch !== 'undefined' && !globalThis.__advisersImapTestHook && connect === undefined) {
    // No network in tests unless a connector is injected; real calls use TLS below.
  }
  const socket = await new Promise((resolve, reject) => {
    const onError = (e) => reject(e)
    const s = connect ? connect({ host, port, secure }) : secure ? tls.connect({ host, port, rejectUnauthorized }) : net.connect({ host, port })
    if (typeof s.then === 'function') { s.then((x) => resolve(x), reject); return }
    s.once('error', onError)
    s.once(secure ? 'secureConnect' : 'connect', () => { s.off('error', onError); resolve(s) })
  })
  socket.setTimeout?.(timeoutMs)
  const reader = createReader(socket)
  let tagNo = 0
  const tag = () => 'A' + (++tagNo)
  const command = async (text) => {
    const t = tag()
    socket.write(`${t} ${text}${CRLF}`)
    const r = await reader.response(t)
    if (!/^OK/i.test(r.status.split(' ').slice(1).join(' '))) throw new Error(`IMAP ${text.split(' ')[0]} failed: ${r.status}`)
    return r
  }
  try {
    const greeting = await reader.readLine()
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error(`IMAP greeting failed: ${greeting}`)
    await command(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`)
    const selected = await command(`EXAMINE ${imapQuote(mailbox)}`)
    const exists = selected.untagged.find((l) => /^\* \d+ EXISTS/i.test(l))
    if (!exists) throw new Error('IMAP EXAMINE did not return EXISTS')
    const search = await command(`UID SEARCH SINCE ${imapSinceDate(sinceDays)}`)
    const searchLine = search.untagged.find((l) => /^\* SEARCH/i.test(l)) ?? ''
    const uids = searchLine.split(/\s+/).slice(2).filter((x) => /^\d+$/.test(x)).map(Number)
    const wanted = uids.slice(-Math.max(0, limit))
    const messages = []
    if (wanted.length) {
      const fetched = await command(`UID FETCH ${wanted.join(',')} (BODY.PEEK[])`)
      for (const literal of fetched.literals) messages.push({ uid: null, raw: literal })
      const uidMatches = fetched.untagged.filter((l) => /^\* \d+ FETCH/i.test(l))
      for (let i = 0; i < uidMatches.length && i < messages.length; i++) {
        const m = /^\* (\d+) FETCH/i.exec(uidMatches[i]); if (m) messages[i].uid = Number(m[1])
      }
    }
    await command('LOGOUT').catch(() => {})
    return messages
  } finally {
    try { socket.end() } catch {}
    try { socket.destroy?.() } catch {}
  }
}
