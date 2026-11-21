/**
 * Shared fixtures for the 0.4.0 mail-entry tests.
 *
 * - openMailStore(): throwaway ADVISERS_HOME + SqliteStore + the v22 mail
 *   tables. Until schema-v22 lands in lib/sqlite.js the test creates the mail
 *   tables here with the frozen DDL from the 0.4 implementation plan; once
 *   v22 is merged the CREATE TABLE IF NOT EXISTS statements are no-ops.
 * - startMockImap(): a loopback, plain-text IMAP mock used through the
 *   TEST-ONLY `connect` injection of lib/mail-imap.js. It records every
 *   command so tests can assert the read-only whitelist and cursor commands.
 * - eml fixtures with optional MIME attachment metadata.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mailAccountAdd } from '../lib/mail.js'
import { SqliteStore } from '../lib/sqlite.js'

export const MAIL_V22_DDL = `
CREATE TABLE IF NOT EXISTS mail_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, tls TEXT NOT NULL, username TEXT NOT NULL, mailbox TEXT NOT NULL DEFAULT 'INBOX', status TEXT NOT NULL DEFAULT 'active', default_matter_id TEXT, client_id TEXT, retention_days INTEGER NOT NULL DEFAULT 30, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_cursors (account_id TEXT NOT NULL, mailbox TEXT NOT NULL, uidvalidity TEXT, last_uid INTEGER, uidnext TEXT, status TEXT NOT NULL DEFAULT 'ok', updated_at TEXT NOT NULL, PRIMARY KEY(account_id, mailbox));
CREATE TABLE IF NOT EXISTS mail_messages (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, mailbox TEXT NOT NULL, uid INTEGER NOT NULL, uidvalidity TEXT, message_id TEXT, dedupe_key TEXT NOT NULL, from_addr TEXT, subject TEXT, sent_at TEXT, received_at TEXT NOT NULL, size_bytes INTEGER, body_text TEXT, body_sha256 TEXT, attachments TEXT NOT NULL DEFAULT '[]', client_id TEXT, project_id TEXT, status TEXT NOT NULL DEFAULT 'new', candidate_ids TEXT NOT NULL DEFAULT '[]', purged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_dedupe ON mail_messages(account_id, dedupe_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_uid ON mail_messages(account_id, mailbox, uidvalidity, uid);
CREATE INDEX IF NOT EXISTS idx_mail_client ON mail_messages(client_id, status);
CREATE TABLE IF NOT EXISTS mail_sync_runs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, mailbox TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, fetched INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, uidvalidity TEXT, last_uid_before INTEGER, last_uid_after INTEGER, error_code TEXT);
`

/** Create the v22 mail tables if lib/sqlite.js has not migrated them yet. */
export function createMailTables(store) {
  store.db.exec(MAIL_V22_DDL)
}

export function openMailStore(prefix = 'advisers-mail-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const store = new SqliteStore(join(root, 'state.db'))
  createMailTables(store)
  return {
    root,
    home,
    store,
    cleanup() {
      try { store.close() } catch {}
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function writeEml(dir, name, content) {
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

const DEFAULT_DATE = 'Thu, 12 Nov 2026 10:00:00 +0800'

export function makeEml({
  from = '王工 <wang@acme.cn>',
  to = 'me@example.com',
  subject = '报价',
  messageId = '<mail-1@example.com>',
  date = DEFAULT_DATE,
  body = '我周五前把报价发给你。',
  extraHeaders = [],
} = {}) {
  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + subject,
    'Date: ' + date,
    ...(messageId ? ['Message-ID: ' + messageId] : []),
    ...extraHeaders,
  ]
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n'
}

export function makeEmlWithAttachment({
  messageId = '<mail-att@example.com>',
  body = '我周五前把报价发给你。',
  filename = 'quote.pdf',
  attachmentText = 'hello pdf content',
  mime = 'application/pdf',
} = {}) {
  const payload = Buffer.from(attachmentText, 'utf8')
  const base64 = payload.toString('base64').replace(/(.{60})/g, '$1\r\n')
  return [
    'From: 王工 <wang@acme.cn>',
    'To: me@example.com',
    'Subject: 报价与附件',
    'Date: ' + DEFAULT_DATE,
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUNDARY"',
    '',
    '--BOUNDARY',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    '--BOUNDARY',
    'Content-Type: ' + mime + '; name="' + filename + '"',
    'Content-Disposition: attachment; filename="' + filename + '"',
    'Content-Transfer-Encoding: base64',
    '',
    base64,
    '--BOUNDARY--',
    '',
  ].join('\r\n')
}

function setMembers(setText) {
  const trimmed = String(setText).trim()
  if (!trimmed) return []
  const out = []
  for (const part of trimmed.split(',')) {
    const match = /^(\d+):(?:(\d+)|\*)$/.exec(part.trim())
    if (!match) { if (/^\d+$/.test(part.trim())) out.push(Number(part)); continue }
    out.push({ from: Number(match[1]), to: match[2] ? Number(match[2]) : null })
  }
  return out
}

function uidsInSet(messages, setText) {
  const members = setMembers(setText)
  const uids = messages.map((message) => message.uid)
  const result = []
  for (const member of members) {
    if (typeof member === 'number') { if (uids.includes(member)) result.push(member); continue }
    for (const uid of uids) {
      if (uid < member.from) continue
      if (member.to != null && uid > member.to) continue
      result.push(uid)
    }
  }
  return [...new Set(result)].sort((a, b) => a - b)
}

function headerPart(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  const end = text.indexOf('\r\n\r\n') >= 0 ? text.indexOf('\r\n\r\n') : text.indexOf('\n\n')
  if (end === -1) return text + '\r\n\r\n'
  return text.slice(0, end) + '\r\n\r\n'
}

/**
 * Start a loopback mock IMAP server. `messages` is [{ uid?, raw }].
 * The returned object exposes mutable `state` (uidvalidity, messages,
 * failUids) and the recorded command lines.
 */
export async function startMockImap({
  messages = [],
  uidvalidity = '100',
  uidnext = null,
  failLogin = false,
  advertiseStarttls = false,
  failStarttls = true,
} = {}) {
  const state = {
    uidvalidity: String(uidvalidity),
    messages: messages.map((message, index) => ({ uid: message.uid ?? index + 1, raw: Buffer.from(message.raw ?? message, 'utf8') })),
    uidnext,
    failUids: new Set(),
    failLogin,
    advertiseStarttls,
    failStarttls,
    starttlsSeen: false,
  }
  const commands = []
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    let tlsPending = false
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write('* OK mock IMAP ready\r\n')
    socket.on('data', (chunk) => {
      if (tlsPending) { try { socket.destroy() } catch {}; return }
      buffer += chunk.toString('latin1')
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        commands.push(line)
        const tag = line.split(' ')[0]
        const rest = line.slice(tag.length + 1)
        const send = (text) => { try { socket.write(text) } catch {} }
        const ok = (text = 'completed') => send(tag + ' OK ' + text + '\r\n')
        if (/^CAPABILITY\b/i.test(rest)) {
          send('* CAPABILITY IMAP4rev1 UIDPLUS' + (state.advertiseStarttls ? ' STARTTLS' : '') + '\r\n')
          ok('CAPABILITY')
        } else if (/^STARTTLS\b/i.test(rest)) {
          state.starttlsSeen = true
          if (!state.advertiseStarttls) { send(tag + ' BAD STARTTLS unavailable\r\n'); continue }
          send(tag + ' OK Begin TLS negotiation now\r\n')
          tlsPending = true
          if (state.failStarttls) setTimeout(() => { try { socket.destroy() } catch {} }, 10)
        } else if (/^LOGIN\b/i.test(rest)) {
          if (state.failLogin) send(tag + ' NO [AUTHENTICATIONFAILED] invalid credentials\r\n')
          else ok('LOGIN')
        } else if (/^EXAMINE\b/i.test(rest)) {
          const next = state.uidnext ?? (state.messages.length ? Math.max(...state.messages.map((message) => message.uid)) + 1 : 1)
          send('* ' + state.messages.length + ' EXISTS\r\n')
          send('* OK [UIDVALIDITY ' + state.uidvalidity + '] UIDs valid\r\n')
          send('* OK [UIDNEXT ' + next + '] Predicted next UID\r\n')
          ok('[READ-ONLY] EXAMINE')
        } else if (/^UID SEARCH\b/i.test(rest)) {
          let uids
          const since = /^UID SEARCH SINCE\b/i.test(rest)
          const range = /^UID SEARCH UID (\S+)$/i.exec(rest)
          if (since) uids = state.messages.map((message) => message.uid)
          else if (range) uids = uidsInSet(state.messages, range[1])
          else uids = []
          send('* SEARCH' + (uids.length ? ' ' + uids.join(' ') : '') + '\r\n')
          ok('SEARCH')
        } else if (/^UID FETCH\b/i.test(rest)) {
          const match = /^UID FETCH (\S+) \((.*)\)$/i.exec(rest)
          const wanted = match ? uidsInSet(state.messages, match[1]) : []
          const wantBody = match ? /BODY\.PEEK\[\]/i.test(match[2]) : false
          for (const uid of wanted) {
            if (state.failUids.has(uid)) continue
            const message = state.messages.find((row) => row.uid === uid)
            if (!message) continue
            const sequence = state.messages.indexOf(message) + 1
            if (wantBody) {
              send(Buffer.concat([
                Buffer.from('* ' + sequence + ' FETCH (UID ' + uid + ' BODY[] {' + message.raw.length + '}\r\n', 'latin1'),
                message.raw,
                Buffer.from(')\r\n', 'latin1'),
              ]))
            } else {
              const header = Buffer.from(headerPart(message.raw), 'utf8')
              send(Buffer.concat([
                Buffer.from('* ' + sequence + ' FETCH (UID ' + uid + ' RFC822.SIZE ' + message.raw.length + ' BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {' + header.length + '}\r\n', 'latin1'),
                header,
                Buffer.from(')\r\n', 'latin1'),
              ]))
            }
          }
          ok('FETCH')
        } else if (/^LOGOUT\b/i.test(rest)) {
          send('* BYE mock closing\r\n')
          ok('LOGOUT')
        } else {
          send(tag + ' BAD unknown command\r\n')
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    state,
    commands,
    port: server.address().port,
    /** Test-only loopback connect injection (never used by product code). */
    connect: ({ host, port }) => net.connect({ host, port }),
    async close() {
      for (const socket of sockets) { try { socket.destroy() } catch {} }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Add an account with a stored credential in a throwaway home. */
export function addTestAccount(store, home, overrides = {}) {
  return mailAccountAdd(store, {
    name: 'work',
    host: '127.0.0.1',
    port: 993,
    tls: 'tls',
    username: 'me@example.com',
    ...overrides,
  }, { home, credential: { pass: overrides.pass ?? 'app-password-secret' } }).account
}
