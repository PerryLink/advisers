/**
 * Read-only IMAP session for the 0.4.0 mail entry.
 *
 * This is deliberately a separate, stricter client from lib/imap.js (which
 * stays untouched for the deprecated `capture --from-imap` path):
 *
 * - TLS ONLY. The product path is implicit TLS on 993 (`tls.connect`,
 *   rejectUnauthorized: true, servername = host) or an opt-in STARTTLS
 *   upgrade on 143. There is no `secure:false` flag and no cleartext
 *   fallback: a server that does not advertise STARTTLS is refused with
 *   E_IMAP_TLS and the session is torn down before LOGIN.
 * - READ-ONLY command allowlist: CAPABILITY, LOGIN, STARTTLS, EXAMINE,
 *   UID SEARCH, UID FETCH (BODY.PEEK[...]), LOGOUT. No SELECT, STORE,
 *   APPEND, EXPUNGE, COPY, MOVE, DELETE. The command log never contains the
 *   password (LOGIN is recorded redacted).
 * - UIDVALIDITY/UIDNEXT are parsed from the EXAMINE response; sync cursor
 *   policy lives in lib/mail.js.
 * - Two-phase fetch: first `UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS ...]` for
 *   every candidate, then full `BODY.PEEK[]` only for messages at or below
 *   maxMessageBytes. Oversize messages are returned header-only; attachment
 *   bytes are never written to disk.
 * - Every remote string in an error is sanitised (no ANSI/OSC/bidi, one line)
 *   and the server banner/certificate details are never echoed.
 *
 * `connect` is a TEST-ONLY injection point (a plain loopback socket factory,
 * the same pattern lib/imap.js already exposes). When it is supplied the
 * module talks the mock protocol without TLS; lib/mail.js never supplies it.
 */
import net from 'node:net'
import tls from 'node:tls'
import { imapQuote, imapSinceDate } from './imap.js'
import { sanitizeConsoleText } from './text-safe.js'
import { isMailError, mailError, MAIL_ERROR_CODES } from './mail-errors.js'

export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_LITERAL_BYTES = 25 * 1024 * 1024
export const MAX_FETCH_CHUNK = 25
export const READ_ONLY_COMMANDS = Object.freeze(['CAPABILITY', 'LOGIN', 'STARTTLS', 'EXAMINE', 'LOGOUT'])
const FORBIDDEN_COMMANDS = ['SELECT', 'STORE', 'APPEND', 'EXPUNGE', 'COPY', 'MOVE', 'DELETE', 'CREATE', 'RENAME', 'SUBSCRIBE']
const CRLF = '\r\n'

function timeoutError() {
  const error = new Error('IMAP request timed out')
  error.imapTimeout = true
  return error
}

function literalTooLargeError(size) {
  const error = new Error('IMAP literal is larger than the configured limit (' + size + ' bytes)')
  error.imapTooLarge = true
  return error
}

function createReader(socket, { idleTimeoutMs = DEFAULT_TIMEOUT_MS, maxLiteralBytes = MAX_LITERAL_BYTES } = {}) {
  let buffer = Buffer.alloc(0)
  let ended = false
  let error
  let wake = null
  let timer = null
  let deadline = Number.POSITIVE_INFINITY

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  const wakeUp = () => { clearTimer(); if (wake) { const w = wake; wake = null; w() } }
  const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); wakeUp() }
  const onEnd = () => { ended = true; wakeUp() }
  const onError = (e) => { error = e; wakeUp() }
  socket.on('data', onData)
  socket.on('end', onEnd)
  socket.on('error', onError)

  const waitData = () => new Promise((resolve) => {
    if (buffer.length || ended || error) return resolve()
    const remaining = deadline - Date.now()
    if (remaining <= 0) { error = timeoutError(); return resolve() }
    wake = resolve
    timer = setTimeout(() => {
      timer = null
      error = timeoutError()
      wakeUp()
    }, Math.max(1, Math.min(idleTimeoutMs, remaining)))
  })

  async function readLine() {
    for (;;) {
      const index = buffer.indexOf('\r\n')
      if (index >= 0) { const line = buffer.subarray(0, index).toString('latin1'); buffer = buffer.subarray(index + 2); return line }
      if (error) throw error
      if (ended) throw new Error('IMAP connection ended before a complete line')
      await waitData()
    }
  }

  async function readBytes(size) {
    if (size > maxLiteralBytes) throw literalTooLargeError(size)
    while (buffer.length < size) {
      if (error) throw error
      if (ended) throw new Error('IMAP connection ended inside a literal')
      await waitData()
    }
    const data = buffer.subarray(0, size); buffer = buffer.subarray(size); return data
  }

  async function response(tag) {
    const records = []
    for (;;) {
      const line = await readLine()
      if (line.startsWith(tag + ' ')) return { records, statusLine: line }
      const record = { line, literal: undefined }
      records.push(record)
      const match = /\{(\d+)\}$/.exec(line)
      if (match) record.literal = await readBytes(Number(match[1]))
    }
  }

  return {
    begin(timeoutMs) { deadline = Date.now() + Math.max(1, timeoutMs) },
    readLine,
    response,
    clearTimer,
    dispose() {
      clearTimer()
      try { socket.off('data', onData) } catch {}
      try { socket.off('end', onEnd) } catch {}
      try { socket.off('error', onError) } catch {}
    },
  }
}

function mapSessionError(error, phase) {
  if (error && typeof error.code === 'string' && error.code.startsWith('E_')) return error
  const message = String(error?.message ?? error)
  if (error?.imapTimeout || /timed out/i.test(message)) {
    return mailError(MAIL_ERROR_CODES.IMAP_TIMEOUT, 'IMAP request timed out', 'check the network and the server; advisors never retries a cleartext connection')
  }
  if (error?.imapTooLarge) {
    return mailError(MAIL_ERROR_CODES.MAIL_TOO_LARGE, 'an IMAP response exceeded the literal size limit', 'increase --max-message-bytes only if you trust the server and have memory to spare')
  }
  const safe = sanitizeConsoleText(message, { max: 300 })
  if (phase === 'tls' || /certificate|handshake|ssl|tls|eproto/i.test(message)) {
    return mailError(MAIL_ERROR_CODES.IMAP_TLS, 'IMAP TLS connection failed: ' + safe, 'the server certificate must be valid for the configured host; advisers never falls back to cleartext')
  }
  return mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'IMAP protocol error: ' + safe)
}

function openTlsSocket({ host, port, timeoutMs, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let socket
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket?.destroy?.() } catch {}
      reject(mailError(MAIL_ERROR_CODES.IMAP_TIMEOUT, 'IMAP TLS connect timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    try {
      socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized })
    } catch (error) {
      finish(reject, mapSessionError(error, 'tls'))
      return
    }
    socket.once('secureConnect', () => finish(resolve, socket))
    socket.once('error', (error) => finish(reject, mapSessionError(error, 'tls')))
  })
}

function openPlainSocket({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let socket
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket?.destroy?.() } catch {}
      reject(mailError(MAIL_ERROR_CODES.IMAP_TIMEOUT, 'IMAP connect timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    try {
      socket = net.connect({ host, port })
    } catch (error) {
      finish(reject, mapSessionError(error, 'connect'))
      return
    }
    socket.once('connect', () => finish(resolve, socket))
    socket.once('error', (error) => finish(reject, mapSessionError(error, 'connect')))
  })
}

function upgradeToTls(socket, { host, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let secure
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { secure?.destroy?.() } catch {}
      reject(mailError(MAIL_ERROR_CODES.IMAP_TLS, 'STARTTLS handshake timed out'))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    try {
      secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
    } catch (error) {
      finish(reject, mapSessionError(error, 'tls'))
      return
    }
    secure.once('secureConnect', () => finish(resolve, secure))
    secure.once('error', (error) => finish(reject, mapSessionError(error, 'tls')))
  })
}

function parseCapabilities(records) {
  const capabilities = []
  for (const record of records) {
    const match = /^\* CAPABILITY (.+)$/i.exec(record.line)
    if (match) capabilities.push(...match[1].trim().split(/\s+/))
  }
  return capabilities
}

function parseSearch(records) {
  const uids = []
  for (const record of records) {
    const match = /^\* SEARCH(?: (.+))?$/i.exec(record.line)
    if (!match) continue
    for (const token of String(match[1] ?? '').trim().split(/\s+/)) {
      if (/^\d+$/.test(token)) uids.push(Number(token))
    }
  }
  return uids
}

function parseFetchRecords(records) {
  const out = []
  for (const record of records) {
    if (!/^\* \d+ FETCH/i.test(record.line)) continue
    const uid = /\bUID (\d+)\b/i.exec(record.line)
    const size = /\bRFC822\.SIZE (\d+)\b/i.exec(record.line)
    out.push({
      uid: uid ? Number(uid[1]) : null,
      size: size ? Number(size[1]) : null,
      literal: record.literal,
    })
  }
  return out
}

function assertNotForbidden(commandText) {
  const verb = String(commandText).trim().split(/\s+/)[0]?.toUpperCase()
  const top = verb === 'UID' ? String(commandText).trim().split(/\s+/)[1]?.toUpperCase() : verb
  if (FORBIDDEN_COMMANDS.includes(top) || FORBIDDEN_COMMANDS.includes(verb)) {
    throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'refusing non-read-only IMAP command: ' + top)
  }
}

/**
 * Open one read-only IMAP session (implicit TLS or STARTTLS) and LOGIN.
 * The returned session exposes capability/examine/search/fetch/logout.
 */
export async function openMailImapSession(options = {}) {
  const {
    host, port, tls: mode = 'tls', user, pass, connect,
    timeoutMs = DEFAULT_TIMEOUT_MS, idleTimeoutMs = timeoutMs,
    maxLiteralBytes = MAX_LITERAL_BYTES,
  } = options
  if (!host || !user || !pass) throw mailError(MAIL_ERROR_CODES.CONFIG, 'IMAP host/user/password are required')
  if (!['tls', 'starttls'].includes(mode)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'unsupported IMAP transport: ' + String(mode), 'use tls (993) or starttls (143)')
  const testSocket = typeof connect === 'function'
  let socket
  let reader
  const commands = []
  let tagNo = 0
  let authenticated = false

  const closeSocket = () => {
    try { reader?.dispose?.() } catch {}
    try { socket?.end?.() } catch {}
    try { socket?.destroy?.() } catch {}
  }

  const begin = () => { reader.begin(timeoutMs) }

  async function rawCommand(text) {
    assertNotForbidden(text)
    const tag = 'A' + (++tagNo)
    const verb = String(text).trim().split(/\s+/)[0]?.toUpperCase()
    commands.push(verb === 'LOGIN' ? 'LOGIN [redacted]' : String(text))
    begin()
    socket.write(tag + ' ' + text + CRLF)
    const response = await reader.response(tag)
    const match = /^\S+ (OK|NO|BAD)\b(.*)$/i.exec(response.statusLine)
    if (!match) throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'IMAP server sent an unparseable status line')
    if (match[1].toUpperCase() !== 'OK') {
      const statusText = sanitizeConsoleText(String(match[2] ?? '').trim(), { max: 300 })
      if (verb === 'LOGIN') throw mailError(MAIL_ERROR_CODES.IMAP_AUTH, 'IMAP authentication failed', 'check the account username and app password; modern providers may require OAuth (not supported)')
      if (verb === 'STARTTLS') throw mailError(MAIL_ERROR_CODES.IMAP_TLS, 'the server refused STARTTLS', 'advisers never falls back to cleartext; use implicit TLS on 993')
      throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'IMAP ' + verb + ' was rejected by the server' + (statusText ? ': ' + statusText : ''))
    }
    return response
  }

  const readGreeting = async () => {
    begin()
    const greeting = await reader.readLine()
    const match = /^\* (OK|PREAUTH)\b/i.exec(greeting)
    if (!match) throw mailError(MAIL_ERROR_CODES.IMAP_PROTOCOL, 'IMAP server did not greet with OK/PREAUTH')
    const capabilities = []
    const capabilityResponse = await rawCommand('CAPABILITY')
    capabilities.push(...parseCapabilities(capabilityResponse.records))
    return { preauthenticated: match[1].toUpperCase() === 'PREAUTH', capabilities }
  }

  try {
    if (testSocket) {
      socket = await connect({ host, port, tls: mode })
    } else if (mode === 'tls') {
      socket = await openTlsSocket({ host, port, timeoutMs })
    } else {
      socket = await openPlainSocket({ host, port, timeoutMs })
    }
    reader = createReader(socket, { idleTimeoutMs, maxLiteralBytes })
    const greeting = await readGreeting()
    if (mode === 'starttls' && !testSocket) {
      if (!greeting.capabilities.map((item) => item.toUpperCase()).includes('STARTTLS')) {
        throw mailError(MAIL_ERROR_CODES.IMAP_TLS, 'the server does not advertise STARTTLS', 'use implicit TLS on 993; advisors never sends credentials in cleartext')
      }
      await rawCommand('STARTTLS')
      reader.dispose()
      try { socket = await upgradeToTls(socket, { host, timeoutMs }) } catch (error) {
        throw isMailError(error) ? error : mapSessionError(error, 'tls')
      }
      reader = createReader(socket, { idleTimeoutMs, maxLiteralBytes })
      const postTls = await rawCommand('CAPABILITY')
      greeting.capabilities.push(...parseCapabilities(postTls.records))
    }
    if (!greeting.preauthenticated) await rawCommand('LOGIN ' + imapQuote(user) + ' ' + imapQuote(pass))
    authenticated = true
  } catch (error) {
    closeSocket()
    if (isMailError(error)) throw error
    throw mapSessionError(error, mode === 'tls' ? 'tls' : 'connect')
  }

  const session = {
    host,
    transport: mode,
    commands,
    get authenticated() { return authenticated },

    async capability() {
      const response = await rawCommand('CAPABILITY')
      return parseCapabilities(response.records)
    },

    async examine(mailbox = 'INBOX') {
      const response = await rawCommand('EXAMINE ' + imapQuote(mailbox))
      const lines = response.records.map((record) => record.line).concat([response.statusLine])
      let exists = null
      let uidValidity = null
      let uidNext = null
      for (const line of lines) {
        const existsMatch = /^\* (\d+) EXISTS/i.exec(line)
        if (existsMatch) exists = Number(existsMatch[1])
        const validity = /\[UIDVALIDITY (\d+)\]/i.exec(line)
        if (validity) uidValidity = validity[1]
        const next = /\[UIDNEXT (\d+)\]/i.exec(line)
        if (next) uidNext = next[1]
      }
      return { mailbox, exists, uidValidity, uidNext }
    },

    async searchSince(days = 30) {
      const response = await rawCommand('UID SEARCH SINCE ' + imapSinceDate(days))
      return [...new Set(parseSearch(response.records))].sort((a, b) => a - b)
    },

    async searchUidRange(fromUid) {
      const start = Math.max(1, Math.floor(Number(fromUid) || 1))
      const response = await rawCommand('UID SEARCH UID ' + start + ':*')
      return [...new Set(parseSearch(response.records).filter((uid) => uid >= start))].sort((a, b) => a - b)
    },

    async fetchMessages(uids = [], { maxMessageBytes = 5 * 1024 * 1024 } = {}) {
      const wanted = [...new Set(uids.filter((uid) => Number.isInteger(uid) && uid > 0))].sort((a, b) => a - b)
      if (!wanted.length) return { messages: [], failedUids: [], requested: 0 }
      const headResponse = await rawCommand('UID FETCH ' + wanted.join(',') + ' (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])')
      const metas = parseFetchRecords(headResponse.records)
      const byUid = new Map()
      for (const meta of metas) if (meta.uid != null) byUid.set(meta.uid, meta)
      const failedUids = []
      const messages = []
      const needBody = []
      for (const uid of wanted) {
        const meta = byUid.get(uid)
        if (!meta) { failedUids.push(uid); continue }
        if (meta.size != null && meta.size > maxMessageBytes) {
          messages.push({ uid, size: meta.size, headerRaw: meta.literal ?? null, raw: null, oversize: true })
        } else {
          needBody.push(uid)
        }
      }
      const bodies = new Map()
      for (let index = 0; index < needBody.length; index += MAX_FETCH_CHUNK) {
        const chunk = needBody.slice(index, index + MAX_FETCH_CHUNK)
        const response = await rawCommand('UID FETCH ' + chunk.join(',') + ' (UID BODY.PEEK[])')
        for (const record of parseFetchRecords(response.records)) {
          if (record.uid == null || !record.literal) continue
          bodies.set(record.uid, record.literal)
        }
      }
      for (const uid of needBody) {
        const raw = bodies.get(uid)
        if (!raw) { failedUids.push(uid); continue }
        const meta = byUid.get(uid)
        messages.push({ uid, size: meta?.size ?? raw.length, headerRaw: meta?.literal ?? null, raw, oversize: false })
      }
      return { messages, failedUids, requested: wanted.length }
    },

    async logout() {
      try { await rawCommand('LOGOUT') } catch {}
      authenticated = false
      closeSocket()
    },

    destroy() {
      authenticated = false
      closeSocket()
    },
  }
  return session
}
