/**
 * Public mail-entry API for Advisers 0.4.0 (bin integration calls these).
 *
 * Surfaces:
 *   mailAccountAdd/List/Show/Remove   local account config (credentials live in
 *                                     lib/credentials.js, never in the DB)
 *   mailSync                          the ONLY IMAP network entry point
 *   mailList/mailShow                 local reads (body only with show --body)
 *   mailExtract                       local rules by default; model opt-in
 *   mailLink/mailDismiss              manual review helpers
 *   mailPurge                         retention (30 days by default)
 *   mailImport                        offline .eml/.mbox fallback
 *
 * Invariants:
 * - mailSync performs network I/O BEFORE opening the write transaction and
 *   then commits messages + UIDVALIDITY/UID cursor + run row in ONE
 *   BEGIN IMMEDIATE (lib/mail-store.js applyMailSyncBatch);
 * - UIDVALIDITY changes never delete local rows: the cursor is marked
 *   needs_resync and E_IMAP_UIDVALIDITY asks for --full;
 * - no function logs; errors are coded and never contain the password or the
 *   body; every write appends an audit row in the same transaction;
 * - sync/extract never write to the ledger beyond mail tables + pending
 *   memory_candidates (never auto-accept).
 */
import { hasImapCredential, listImapCredentialAccountIds, readImapCredential, removeImapCredential, saveImapCredential } from './credentials.js'
import { isMailError, mailError, MAIL_ERROR_CODES } from './mail-errors.js'
import { openMailImapSession } from './mail-imap.js'
import { parseMailMessage } from './mail-parse.js'
import { extractCandidatesWithModel, extractLocalCandidates, mailEvidenceSource, toMemoryCandidate } from './mail-extract.js'
import { importMailFiles } from './mail-import.js'
import * as mailDb from './mail-store.js'

export { MAIL_ERROR_CODES }
export const MAIL_MAX_MESSAGE_BYTES = mailDb.MAIL_MAX_MESSAGE_BYTES
export const MAIL_DEFAULT_RETENTION_DAYS = mailDb.MAIL_DEFAULT_RETENTION_DAYS
export const MAIL_LOCAL_ACCOUNT_ID = mailDb.MAIL_LOCAL_ACCOUNT_ID

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function parseHeaderDate(value) {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function listActiveEntities(store, method) {
  try {
    if (typeof store?.[method] !== 'function') return []
    return store[method]({ status: 'active', limit: 500 })
  } catch { return [] }
}

/* ------------------------------------------------------------------ */
/* Accounts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create one mail account. Optionally stores the IMAP credential atomically
 * (options.credential = { user?, pass }); the password is never written to the
 * ledger, argv or logs. `secure:false` / `tls:'none'` are rejected.
 */
export function mailAccountAdd(store, config = {}, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const prepared = mailDb.prepareMailAccount(config, { now, id: options.id })
  const credential = options.credential ?? config.credential
  let credentialSaved = false
  if (credential !== undefined && credential !== null) {
    if (typeof credential !== 'object' || typeof credential.pass !== 'string') {
      throw mailError(MAIL_ERROR_CODES.CONFIG, 'credential must be an object with { user, pass }', 'pass the password from a TTY/app-password prompt or stdin, never from argv')
    }
    const user = credential.user == null ? prepared.username : String(credential.user)
    if (user !== prepared.username) throw mailError(MAIL_ERROR_CODES.CONFIG, 'credential user must match the account username')
    saveImapCredential(prepared.id, { user, pass: credential.pass }, { home: options.home, now })
    credentialSaved = true
  }
  const audit = { actor: options.actor ?? 'local', action: 'mail.account.add', allowed: true, reason: prepared.id }
  try {
    store.mutate(() => mailDb.insertMailAccount(store, prepared), audit)
  } catch (error) {
    if (credentialSaved) { try { removeImapCredential(prepared.id, { home: options.home }) } catch {} }
    throw error
  }
  return { ok: true, command: 'mail account add', account: { ...prepared, hasCredential: credentialSaved } }
}

export function mailAccountList(store, options = {}) {
  mailDb.assertMailTables(store)
  const accounts = mailDb.listMailAccounts(store, { includeRemoved: options.includeRemoved === true })
  const credentialIds = new Set(listImapCredentialAccountIds({ home: options.home }))
  const rows = accounts.map((account) => ({ ...account, hasCredential: credentialIds.has(account.id) }))
  return { ok: true, command: 'mail account ls', accounts: rows, total: rows.length }
}

export function mailAccountShow(store, ref, options = {}) {
  mailDb.assertMailTables(store)
  const account = mailDb.getMailAccount(store, ref, { includeRemoved: options.includeRemoved === true })
  return {
    ok: true, command: 'mail account show',
    account: { ...account, hasCredential: hasImapCredential(account.id, { home: options.home }) },
  }
}

/**
 * Remove one account: credential file + sync cursors + run history; local
 * message rows are kept by default (they may back accepted evidence).
 */
export function mailAccountRemove(store, ref, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const account = mailDb.getMailAccount(store, ref)
  let credentialRemoved = false
  if (options.removeCredential !== false) credentialRemoved = removeImapCredential(account.id, { home: options.home })
  const audit = { actor: options.actor ?? 'local', action: 'mail.account.remove', allowed: true, reason: account.id }
  const outcome = store.mutate(
    () => mailDb.removeMailAccountData(store, account.id, { purgeMessages: options.purgeMessages === true, now }),
    audit,
  )
  return {
    ok: true, command: 'mail account rm',
    accountId: account.id,
    removed: true,
    credentialRemoved,
    messagesDeleted: outcome.result.messagesDeleted,
  }
}

/* ------------------------------------------------------------------ */
/* Sync                                                               */
/* ------------------------------------------------------------------ */

function syncResult(account, mailbox, extras) {
  return { ok: true, command: 'mail sync', accountId: account.id, mailbox, ...extras }
}

/**
 * Fetch new mail into the local ledger. Read-only IMAP (EXAMINE/FETCH); TLS
 * only. Returns the frozen CLI JSON shape; dryRun writes nothing at all.
 */
export async function mailSync(store, accountRef, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const full = options.full === true
  const dryRun = options.dryRun === true
  const startedMs = Date.now()
  const account = mailDb.getMailAccount(store, accountRef)
  if (!['tls', 'starttls'].includes(account.tls)) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'account ' + account.name + ' is not an IMAP account', 'the local .eml import account cannot sync; add an IMAP account with implicit TLS')
  }
  const mailbox = options.mailbox == null ? account.mailbox : String(options.mailbox)
  const cursor = mailDb.getMailCursor(store, account.id, mailbox)
  if (cursor?.status === 'needs_resync' && !full) {
    throw mailError(MAIL_ERROR_CODES.IMAP_UIDVALIDITY, 'mailbox ' + mailbox + ' needs a full rescan (UIDVALIDITY changed on an earlier sync)', 'run `advisers mail sync ' + account.name + ' --full`')
  }
  const credential = readImapCredential(account.id, { home: options.home })
  if (!credential) {
    throw mailError(MAIL_ERROR_CODES.CREDENTIALS_MISSING, 'no stored credential for mail account ' + account.name, 'run `advisers mail account add` again and provide the password through the TTY prompt or --pass-stdin')
  }
  const startedAt = now.toISOString()
  const session = await openMailImapSession({
    host: account.host,
    port: account.port,
    tls: account.tls,
    user: credential.user || account.username,
    pass: credential.pass,
    connect: options.connect,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
  })
  try {
    const box = await session.examine(mailbox)
    const observedValidity = box.uidValidity == null ? null : String(box.uidValidity)
    const previousValidity = cursor?.uidvalidity ?? null
    const validityChanged = Boolean(previousValidity && observedValidity && previousValidity !== observedValidity)
    if (validityChanged && !full) {
      if (!dryRun) {
        const audit = { actor: options.actor ?? 'local', action: 'mail.sync.needs-resync', allowed: true, reason: account.id + ' ' + mailbox }
        store.mutate(() => {
          mailDb.markMailCursorNeedsResync(store, { accountId: account.id, mailbox, uidvalidity: observedValidity, uidnext: box.uidNext, now })
          mailDb.updateMailAccount(store, account.id, { lastError: MAIL_ERROR_CODES.IMAP_UIDVALIDITY }, { now })
        }, audit)
      }
      throw mailError(
        MAIL_ERROR_CODES.IMAP_UIDVALIDITY,
        'mailbox ' + mailbox + ' UIDVALIDITY changed (' + previousValidity + ' -> ' + observedValidity + ')',
        'run `advisers mail sync ' + account.name + ' --full` to rescan; no local rows were deleted',
      )
    }
    const sinceDays = Math.max(1, Math.min(3650, Number(options.sinceDays ?? account.retentionDays ?? 30) || 30))
    let uids
    if (cursor?.lastUid != null && !full) {
      uids = await session.searchUidRange(Number(cursor.lastUid) + 1)
      uids = uids.filter((uid) => uid > Number(cursor.lastUid))
    } else {
      uids = await session.searchSince(sinceDays)
    }
    const limit = Math.max(1, Math.min(mailDb.MAIL_MAX_SYNC_LIMIT, Number(options.limit) || mailDb.MAIL_DEFAULT_SYNC_LIMIT))
    const selected = uids.slice(0, limit)
    const fetched = await session.fetchMessages(selected, { maxMessageBytes: options.maxMessageBytes })
    const rows = []
    const failedUids = [...fetched.failedUids]
    for (const message of fetched.messages) {
      try {
        const raw = message.oversize
          ? (message.headerRaw ? message.headerRaw.toString('utf8') + '\n\n' : '')
          : (message.raw ? message.raw.toString('utf8') : '')
        const parsed = parseMailMessage(raw)
        rows.push(mailDb.buildMailMessageRow({
          accountId: account.id,
          mailbox,
          uid: message.uid,
          uidvalidity: observedValidity,
          sizeBytes: message.size,
          receivedAt: startedAt,
          sentAt: parseHeaderDate(parsed.date),
          from: parsed.from,
          subject: parsed.subject,
          messageId: parsed.messageId,
          text: message.oversize ? null : parsed.text,
          attachments: parsed.attachments,
          status: message.oversize ? 'oversize' : null,
          now,
        }))
      } catch {
        failedUids.push(message.uid)
      }
    }
    if (dryRun) {
      let duplicates = 0
      for (const row of rows) if (mailDb.findMailMessageDuplicate(store, account.id, row)) duplicates += 1
      return syncResult(account, mailbox, {
        uidValidity: observedValidity ?? undefined,
        fetched: selected.length, inserted: 0, skipped: duplicates, failed: failedUids.length,
        duplicates, needsResync: false, dryRun: true, full, durationMs: Date.now() - startedMs,
      })
    }
    const audit = { actor: options.actor ?? 'local', action: 'mail.sync', allowed: true, reason: '' }
    const outcome = store.mutate(() => {
      const applied = mailDb.applyMailSyncBatch(store, {
        accountId: account.id,
        mailbox,
        uidvalidity: observedValidity,
        messages: rows,
        failedUids,
        full,
        uidnext: box.uidNext,
        startedAt,
        previousCursor: cursor,
        now,
        fetched: selected.length,
      })
      audit.reason = applied.inserted + ' inserted, ' + applied.skipped + ' skipped, ' + applied.failed + ' failed'
      return applied
    }, audit)
    return syncResult(account, mailbox, {
      uidValidity: observedValidity ?? undefined,
      fetched: selected.length,
      inserted: outcome.result.inserted,
      skipped: outcome.result.skipped,
      failed: outcome.result.failed,
      duplicates: outcome.result.duplicates,
      needsResync: false,
      dryRun: false,
      full,
      durationMs: Date.now() - startedMs,
    })
  } catch (error) {
    if (!dryRun && isMailError(error) && error.code !== MAIL_ERROR_CODES.IMAP_UIDVALIDITY) {
      try { store.mutate(() => mailDb.updateMailAccount(store, account.id, { lastError: error.code }, { now })) } catch {}
    }
    throw error
  } finally {
    try { await session.logout() } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* Local reads                                                        */
/* ------------------------------------------------------------------ */

export function mailList(store, options = {}) {
  mailDb.assertMailTables(store)
  const accountId = options.account ? mailDb.getMailAccount(store, options.account).id : options.accountId
  const sinceDays = options.sinceDays == null ? undefined : Number(options.sinceDays)
  const result = mailDb.listMailMessages(store, {
    accountId,
    clientId: options.clientId,
    projectId: options.projectId,
    status: options.status,
    retained: options.retained,
    sinceDays,
    limit: options.limit,
    offset: options.offset,
    now: options.now,
  })
  return { ok: true, command: 'mail ls', ...result }
}

export function mailShow(store, ref, options = {}) {
  mailDb.assertMailTables(store)
  const includeBody = options.body === true
  const message = mailDb.getMailMessage(store, ref, { includeBody })
  if (includeBody && message.bodyText == null) {
    throw mailError(
      MAIL_ERROR_CODES.NOT_RETAINED,
      'the body of ' + message.id + ' is not retained' + (message.purgedAt ? ' (purged ' + message.purgedAt + ')' : ' (metadata-only row)'),
      'metadata and body_sha256 are kept for evidence; re-sync the mailbox to read the body again',
    )
  }
  return { ok: true, command: 'mail show', message }
}

/* ------------------------------------------------------------------ */
/* Review helpers                                                     */
/* ------------------------------------------------------------------ */

export function mailLink(store, ref, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const message = mailDb.getMailMessage(store, ref)
  const clientId = options.clientId == null ? (message.clientId ?? null) : String(options.clientId)
  const projectId = options.projectId == null ? (message.projectId ?? null) : String(options.projectId)
  const audit = { actor: options.actor ?? 'local', action: 'mail.link', allowed: true, reason: message.id }
  const updated = store.mutate(() => mailDb.updateMailMessage(store, message.id, { clientId, projectId, status: 'linked' }, { now }), audit).result
  return { ok: true, command: 'mail link', message: updated }
}

export function mailDismiss(store, ref, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const message = mailDb.getMailMessage(store, ref)
  const audit = { actor: options.actor ?? 'local', action: 'mail.dismiss', allowed: true, reason: message.id }
  const updated = store.mutate(() => mailDb.updateMailMessage(store, message.id, { status: 'dismissed' }, { now }), audit).result
  return { ok: true, command: 'mail dismiss', message: updated }
}

/* ------------------------------------------------------------------ */
/* Retention                                                          */
/* ------------------------------------------------------------------ */

/**
 * Clear retained bodies older than each account's retention window (or
 * --older-than). Messages with a pending candidate are skipped; metadata,
 * body_sha256, dedupe key and evidence stay.
 */
export function mailPurge(store, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const accountId = options.account ? mailDb.getMailAccount(store, options.account).id : options.accountId
  const plan = mailDb.planMailPurge(store, {
    now,
    olderThanDays: options.olderThanDays == null ? undefined : Number(options.olderThanDays),
    accountId,
  })
  if (options.dryRun === true) {
    return {
      ok: true, command: 'mail purge', dryRun: true,
      messagesPurged: 0, wouldPurge: plan.targets.length,
      bytesFreed: 0, bytesWouldFree: plan.bytesFreed,
      skippedPending: plan.skippedPending,
    }
  }
  const audit = { actor: options.actor ?? 'local', action: 'mail.purge', allowed: true, reason: '' }
  const purged = store.mutate(() => {
    const count = mailDb.purgeMailBodies(store, plan.targets.map((target) => target.id), { now })
    audit.reason = count + ' bodies purged, ' + plan.skippedPending + ' skipped (pending candidates)'
    return count
  }, audit)
  return {
    ok: true, command: 'mail purge', dryRun: false,
    messagesPurged: purged.result,
    bytesFreed: plan.bytesFreed,
    skippedPending: plan.skippedPending,
  }
}

/* ------------------------------------------------------------------ */
/* Extraction                                                         */
/* ------------------------------------------------------------------ */

function extractCandidateRecord(candidate, message, { matterId, now }) {
  return toMemoryCandidate(candidate, { message, matterId, now })
}

/**
 * Extract commitment candidates from locally retained mail.
 * Default: pure local rules, zero network. Model mode is explicit opt-in
 * (`model:true` + `confirmModel:true` + apiKey) and requires secrecy 0.
 */
export async function mailExtract(store, options = {}) {
  mailDb.assertMailTables(store)
  const now = asDate(options.now)
  const useModel = options.model === true
  const mode = useModel ? 'model' : 'local'
  if (useModel) {
    if (options.confirmModel !== true) {
      throw mailError(MAIL_ERROR_CODES.MODEL_DISABLED, 'model extraction requires explicit confirmation', 'the default --local path is offline and needs no key; pass --model --yes only after deciding the message text may be sent to your configured model provider')
    }
    if (!options.apiKey) throw mailError(MAIL_ERROR_CODES.MODEL_DISABLED, 'mail extract --model requires ADVISERS_API_KEY', 'run with --local (default) or configure a model key explicitly')
    if (Number(options.secrecy) > 0) throw mailError(MAIL_ERROR_CODES.MODEL_DISABLED, 'model extraction is disabled for protected matters (secrecy > 0)', 'use the default local extraction or move the mail to an unprotected matter')
  }
  const account = options.account ? mailDb.getMailAccount(store, options.account) : undefined
  const accountId = account?.id ?? options.accountId
  const messages = mailDb.listMessagesForExtraction(store, {
    accountId,
    ids: options.ids,
    all: options.all === true,
    limit: options.limit,
    now,
  })
  const matterId = options.matterId ?? account?.defaultMatterId
  const clients = listActiveEntities(store, 'listClients')
  const projects = listActiveEntities(store, 'listProjects')
  const batches = []
  let failed = 0
  const failures = []
  for (const message of messages) {
    try {
      if (useModel) {
        const result = await extractCandidatesWithModel({
          text: message.bodyText ?? '',
          subject: message.subject,
          from: message.from,
          receivedAt: message.receivedAt,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          model: options.modelName ?? options.modelId,
          fetchImpl: options.fetchImpl,
          safetyKey: options.safetyKey,
          now,
        })
        batches.push({ message, candidates: result.candidates, safetyWarnings: result.safetyWarnings })
      } else {
        const result = extractLocalCandidates({
          text: message.bodyText ?? '',
          subject: message.subject,
          from: message.from,
          receivedAt: message.receivedAt,
          clients,
          projects,
          now,
        })
        batches.push({ message, candidates: result.candidates })
      }
    } catch (error) {
      // Safety blocks are a hard product stop: never swallow them into a
      // per-message failure count.
      if (error?.name === 'ContentSafetyError') throw error
      failed += 1
      failures.push({ messageId: message.id, code: error?.code ?? null })
    }
  }
  const preview = []
  for (const batch of batches) {
    for (const candidate of batch.candidates) {
      preview.push(extractCandidateRecord(candidate, batch.message, { matterId, now }))
    }
  }
  const safetyWarnings = batches.flatMap((batch) => batch.safetyWarnings ?? [])
  if (options.dryRun === true) {
    return {
      ok: true, command: 'mail extract', mode, dryRun: true,
      scanned: messages.length, candidates: preview.map((candidate) => ({ ...candidate, preview: true })),
      skipped: 0, failed, ...(failures.length ? { failures } : {}), ...(safetyWarnings.length ? { safetyWarnings } : {}),
    }
  }
  const audit = { actor: options.actor ?? 'local', action: 'mail.extract.' + mode, allowed: true, reason: '' }
  const created = []
  store.mutate(() => {
    for (const batch of batches) {
      const ids = []
      for (const candidate of batch.candidates) {
        const record = extractCandidateRecord(candidate, batch.message, { matterId, now })
        const row = store.proposeCandidate(record)
        ids.push(row.id)
        created.push({ ...row, mode })
      }
      const current = mailDb.getMailMessage(store, batch.message.id)
      mailDb.updateMailMessage(store, batch.message.id, {
        status: 'extracted',
        candidateIds: [...(current.candidateIds ?? []), ...ids],
      }, { now })
    }
    audit.reason = created.length + ' candidates from ' + messages.length + ' messages, ' + failed + ' failed'
  }, audit)
  return {
    ok: true, command: 'mail extract', mode, dryRun: false,
    scanned: messages.length, candidates: created, skipped: 0, failed,
    ...(failures.length ? { failures } : {}), ...(safetyWarnings.length ? { safetyWarnings } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Offline import                                                     */
/* ------------------------------------------------------------------ */

/** .eml/.mbox fallback import (no network, no credentials). */
export async function mailImport(store, options = {}, context = {}) {
  return importMailFiles(store, options, context)
}

/** Evidence source for one stored message (used by tests/integration). */
export { mailEvidenceSource }
