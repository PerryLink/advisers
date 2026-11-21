/**
 * Offline .eml/.mbox directory import for the 0.4.0 mail entry.
 *
 * This is the fallback for users whose provider disabled password IMAP
 * (Google Workspace / Microsoft 365): no network, no credentials, no IMAP
 * code path. Imported messages land in mail_messages under a built-in local
 * account (or a caller-supplied account) and then flow through the same
 * `mail extract` / candidate review pipeline.
 *
 * Attachments are metadata only (name/size/mime); no attachment bytes are
 * written anywhere. Empty-body messages are skipped, not silently stored.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { parseMailMessage } from './mail-parse.js'
import { mailError, MAIL_ERROR_CODES } from './mail-errors.js'
import {
  assertMailTables, buildMailMessageRow, ensureLocalMailAccount, findMailMessageDuplicate,
  getMailAccount, insertMailMessage, nextLocalUid, isoOf, MAIL_LOCAL_ACCOUNT_ID, MAIL_LOCAL_MAILBOX,
} from './mail-store.js'

export const EML_EXTENSIONS = Object.freeze(['.eml', '.mbox'])
export const DEFAULT_IMPORT_FILE_LIMIT = 100
export const MAX_IMPORT_FILE_LIMIT = 500
export const MAX_IMPORT_MESSAGES_PER_FILE = 500

function isEmlPath(path) {
  return EML_EXTENSIONS.includes(extname(String(path)).toLowerCase())
}

function listImportFiles(target) {
  if (typeof target !== 'string' || !target.trim()) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail import requires a .eml file or a directory')
  let stat
  try { stat = statSync(target) } catch (error) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'cannot read mail path: ' + String(error?.message ?? error).slice(0, 200))
  }
  if (stat.isFile()) {
    if (!isEmlPath(target)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'not a .eml/.mbox file: ' + target)
    return [target]
  }
  if (!stat.isDirectory()) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail import path is not a file or directory: ' + target)
  try {
    return readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isEmlPath(entry.name))
      .map((entry) => join(target, entry.name))
      .sort()
  } catch (error) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'cannot list mail directory: ' + String(error?.message ?? error).slice(0, 200))
  }
}

/** Split an mbox stream into raw RFC 822 messages (keeping each raw). */
export function splitMboxRaw(raw) {
  const source = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!source.trim()) return []
  const chunks = []
  let current = []
  for (const line of source.split('\n')) {
    if (line.startsWith('From ') && current.length) {
      chunks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks
    .map((chunk) => chunk.replace(/^From [^\n]*\n/, ''))
    .filter((chunk) => chunk.trim())
}

function parseDateHeader(value) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function readMessages(file) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (error) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'cannot read ' + file + ': ' + String(error?.message ?? error).slice(0, 200))
  }
  const isMbox = extname(file).toLowerCase() === '.mbox'
  const raws = isMbox ? splitMboxRaw(raw) : [raw]
  return raws.slice(0, MAX_IMPORT_MESSAGES_PER_FILE)
}

/**
 * Import .eml/.mbox file(s) into mail_messages. No network, no credentials.
 *
 * @param {object} store open SqliteStore
 * @param {{ path?: string, files?: string[], accountId?: string, clientId?: string,
 *   projectId?: string, limit?: number, dryRun?: boolean }} options
 * @param {{ now?: Date }} [context]
 * @returns {{ ok: true, command: 'mail import', accountId: string, dryRun: boolean,
 *   files: number, scanned: number, inserted: number, skipped: number, failed: number }}
 */
export async function importMailFiles(store, options = {}, context = {}) {
  assertMailTables(store)
  const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now())
  const dryRun = options.dryRun === true
  const limit = Math.max(1, Math.min(MAX_IMPORT_FILE_LIMIT, Number(options.limit) || DEFAULT_IMPORT_FILE_LIMIT))
  const requested = Array.isArray(options.files) && options.files.length
    ? options.files.filter(isEmlPath).slice(0, limit)
    : listImportFiles(options.path ?? options.dir ?? options.target).slice(0, limit)
  if (!requested.length) throw mailError(MAIL_ERROR_CODES.CONFIG, 'no .eml/.mbox files found to import')
  let account
  if (options.accountId) {
    account = getMailAccount(store, options.accountId)
    if (!['tls', 'starttls', 'local'].includes(account.tls)) throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail import requires a local or IMAP account')
  } else if (dryRun) {
    // A dry run must not even create the built-in local account row.
    account = { id: MAIL_LOCAL_ACCOUNT_ID, mailbox: MAIL_LOCAL_MAILBOX, tls: 'local' }
  } else {
    account = store.mutate(() => ensureLocalMailAccount(store, { now })).result
  }
  const rows = []
  let failed = 0
  let scanned = 0
  for (const file of requested) {
    let raws
    try { raws = readMessages(file) } catch { failed += 1; continue }
    for (const raw of raws) {
      scanned += 1
      const parsed = parseMailMessage(raw)
      const text = String(parsed.text ?? '')
      if (!text.trim()) continue
      const sentAt = parseDateHeader(parsed.date)
      rows.push(buildMailMessageRow({
        accountId: account.id,
        mailbox: account.mailbox,
        uid: null,
        uidvalidity: 'local',
        sizeBytes: parsed.sizeBytes,
        receivedAt: sentAt ?? isoOf(now),
        sentAt: sentAt ?? null,
        from: parsed.from,
        subject: parsed.subject,
        messageId: parsed.messageId,
        text,
        attachments: parsed.attachments,
        status: 'new',
        clientId: options.clientId ?? null,
        projectId: options.projectId ?? null,
        now,
      }))
    }
  }
  const skippedEmpty = scanned - rows.length
  if (dryRun) {
    let duplicates = 0
    for (const row of rows) if (findMailMessageDuplicate(store, account.id, row)) duplicates += 1
    return {
      ok: true, command: 'mail import', accountId: account.id, dryRun: true,
      files: requested.length, scanned, inserted: 0,
      skipped: skippedEmpty + duplicates, failed,
    }
  }
  const audit = { actor: 'local', action: 'mail.import', allowed: true, reason: '' }
  const result = store.mutate(() => {
    let uid = nextLocalUid(store, account.id, account.mailbox)
    let inserted = 0
    let skipped = skippedEmpty
    for (const row of rows) {
      if (findMailMessageDuplicate(store, account.id, row)) { skipped += 1; continue }
      row.uid = uid
      if (insertMailMessage(store, row)) { inserted += 1; uid += 1 } else { skipped += 1 }
    }
    audit.reason = inserted + ' imported, ' + skipped + ' skipped, ' + failed + ' failed'
    return { inserted, skipped }
  }, audit)
  return {
    ok: true, command: 'mail import', accountId: account.id, dryRun: false,
    files: requested.length, scanned, inserted: result.result.inserted,
    skipped: result.result.skipped, failed,
  }
}
