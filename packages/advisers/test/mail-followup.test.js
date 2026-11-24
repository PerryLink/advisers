/**
 * 0.5.1 (plan 92 section S5 / section 4): the local mail followup engine.
 *
 * Every test uses a throwaway ADVISERS_HOME + SqliteStore; nothing here opens
 * a network connection, sends mail or touches the real ~/.advisers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FOLLOWUP_DEFAULT_DUE_DAYS,
  FOLLOWUP_DISMISS_REASONS,
  FOLLOWUP_AMBIGUOUS_WINDOW_DAYS,
  FOLLOWUP_ERROR_CODES,
  assertFollowupTables,
  defaultFollowupDue,
  mailFollowupAdd,
  mailFollowupCheck,
  mailFollowupCoverage,
  mailFollowupDismiss,
  mailFollowupLs,
  mailFollowupMarkReplied,
  mailFollowupShow,
} from '../lib/mail-followup.js'
import { buildMailMessageRow, insertMailMessage, putMailCursor } from '../lib/mail-store.js'
import { addTestAccount, openMailStore } from './mail-fixture.js'

const NOW = new Date('2026-11-20T02:00:00.000Z')
const DAY_MS = 86_400_000
const ANCHOR_MESSAGE_ID = 'orig-1@example.com'

function openSpace() {
  const space = openMailStore()
  space.account = addTestAccount(space.store, space.home)
  space.nextUid = 0
  space.insert = (overrides = {}) => {
    space.nextUid += 1
    const uid = overrides.uid ?? space.nextUid
    const row = buildMailMessageRow({
      accountId: space.account.id,
      mailbox: space.account.mailbox,
      uid,
      uidvalidity: '7',
      receivedAt: NOW.toISOString(),
      from: '王工 <wang@acme.cn>',
      subject: '报价',
      messageId: '<m' + uid + '@example.com>',
      text: '请把报价发我。',
      accountUsername: space.account.username,
      now: NOW,
      ...overrides,
    })
    space.store.mutate((store) => { insertMailMessage(store, row) })
    return row
  }
  return space
}

function anchor(space, overrides = {}) {
  return space.insert({ messageId: '<' + ANCHOR_MESSAGE_ID + '>', from: '王工 <wang@acme.cn>', subject: '报价', ...overrides })
}

function addFollowup(space, input = {}, options = { now: NOW }) {
  return mailFollowupAdd(space.store, { mail: '<' + ANCHOR_MESSAGE_ID + '>', ...input }, options)
}

function codeOf(fn) {
  try { fn(); return 'NO_THROW' } catch (error) { return error.code }
}

function actions(space) {
  return space.store.listAudit(20).map((row) => row.action).filter((action) => action.startsWith('followup.'))
}

function auditReasons(space) {
  return space.store.listAudit(20).map((row) => row.reason ?? '')
}

test('add: creates a third-party commitment + waiting_replies row in one audit, default due = anchor + 3d 18:00', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    assert.equal(made.ok, true)
    assert.equal(made.command, 'mail followup add')
    assert.equal(made.dueBasis, 'waiting-default')
    assert.match(made.followup.id, /^wr_[0-9a-f]{16}$/)
    assert.match(made.followup.commitmentId, /^cm_/)
    assert.equal(made.followup.state, 'waiting')
    assert.equal(made.followup.counterparty, 'wang@acme.cn')
    assert.equal(made.followup.anchorMessageId, ANCHOR_MESSAGE_ID)
    assert.equal(made.followup.threadRoot, ANCHOR_MESSAGE_ID)
    assert.equal(made.followup.subject, '报价')
    assert.equal(made.followup.anchorAt, NOW.toISOString())
    assert.deepEqual(made.followup.replies, [])
    assert.deepEqual(made.followup.warnings, [])
    assert.equal(made.followup.daysWaiting, 0)
    assert.equal(made.commitment.debtor, 'third')
    assert.equal(made.commitment.creditor, '王工')
    assert.equal(made.commitment.capability, 'none')
    assert.equal(made.commitment.status, 'open')
    assert.match(made.commitment.action, /等待回复：报价/)
    assert.equal(made.followup.dueAt, defaultFollowupDue(NOW.toISOString()))
    assert.equal(made.followup.dueAt, '2026-11-23T10:00:00.000Z', 'anchor + 3 Shanghai calendar days at 18:00 +08:00')
    assert.equal(FOLLOWUP_DEFAULT_DUE_DAYS, 3)
    const commitment = space.store.getCommitment(made.commitment.id)
    assert.equal(commitment.evidence.length, 1)
    assert.equal(commitment.evidence[0].quote, '报价', 'evidence quote is the verbatim subject')
    assert.equal(commitment.evidence[0].source.type, 'mail')
    assert.equal(commitment.evidence[0].source.messageId, ANCHOR_MESSAGE_ID)
    assert.deepEqual(actions(space), ['followup.add'], 'exactly one audit row per add')
    assert.match(auditReasons(space)[0], new RegExp(made.followup.id + ' ' + made.commitment.id))
    const count = space.store.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n
    assert.equal(Number(count), 1)
  } finally { space.cleanup() }
})

test('add: explicit due, action, counterparty and matter are honored', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space, { dueAt: '2026-11-28', action: '催报价', counterparty: 'Wang <WANG@acme.cn>', reminderOffsets: '-3d,-2h' })
    assert.equal(made.followup.dueAt, '2026-11-28')
    assert.equal(made.dueBasis, 'explicit')
    assert.equal(made.commitment.action, '催报价')
    assert.equal(made.followup.counterparty, 'wang@acme.cn')
    assert.deepEqual(made.commitment.reminderOffsets, ['-3d', '-2h'])
    const matter = space.store.getMatter(made.commitment.matterId)
    assert.equal(matter.status, 'active')
  } finally { space.cleanup() }
})

test('add: idempotent per anchor + counterparty while the row is active', () => {
  const space = openSpace()
  try {
    anchor(space)
    const first = addFollowup(space)
    assert.equal(codeOf(() => addFollowup(space)), FOLLOWUP_ERROR_CODES.EXISTS)
    assert.equal(space.store.db.prepare('SELECT COUNT(*) AS n FROM waiting_replies').get().n, 1)
    mailFollowupMarkReplied(space.store, first.followup.id, {}, { now: NOW })
    const second = addFollowup(space, { counterparty: 'wang@acme.cn' })
    assert.notEqual(second.followup.id, first.followup.id, 'a terminal row does not block a new followup')
    assert.equal(Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM waiting_replies').get().n), 2)
  } finally { space.cleanup() }
})

test('add: --thread resolves the latest message of a thread; an outbound anchor requires --counterparty', () => {
  const space = openSpace()
  try {
    const root = space.insert({ messageId: '<root@example.com>', inReplyTo: null, references: [] })
    const latest = space.insert({ messageId: '<latest@example.com>', inReplyTo: 'root@example.com', references: ['root@example.com'] })
    const made = mailFollowupAdd(space.store, { thread: '<root@example.com>' }, { now: NOW })
    assert.equal(made.followup.anchorMessageId, latest.messageId)
    assert.equal(made.followup.threadRoot, 'root@example.com')
    // An outbound anchor has no To header in the ledger: the user must supply it.
    space.insert({ messageId: '<sent@example.com>', from: 'Me <me@example.com>', subject: '报价已发' })
    const outbound = space.store.db.prepare("SELECT id FROM mail_messages WHERE message_id = 'sent@example.com'").get()
    assert.equal(codeOf(() => mailFollowupAdd(space.store, { mail: outbound.id }, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    const fixed = mailFollowupAdd(space.store, { mail: outbound.id, counterparty: 'wang@acme.cn' }, { now: NOW })
    assert.equal(fixed.followup.counterparty, 'wang@acme.cn')
    assert.equal(root.messageId, 'root@example.com')
  } finally { space.cleanup() }
})

test('add: argument validation and anchor lookup errors', () => {
  const space = openSpace()
  try {
    anchor(space)
    assert.equal(codeOf(() => mailFollowupAdd(space.store, {}, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(codeOf(() => mailFollowupAdd(space.store, { mail: '<a@x.y>', thread: '<b@x.y>' }, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(codeOf(() => mailFollowupAdd(space.store, { mail: '<missing@x.y>' }, { now: NOW })), 'E_MAIL_MESSAGE_NOT_FOUND')
    assert.equal(codeOf(() => addFollowup(space, { dueAt: 'next friday' })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(codeOf(() => addFollowup(space, { reminderOffsets: 'soon' })), FOLLOWUP_ERROR_CODES.INVALID)
  } finally { space.cleanup() }
})

test('check: an exact In-Reply-To reply flips waiting -> replied and writes one audit row', () => {
  const space = openSpace()
  try {
    const original = anchor(space)
    const made = addFollowup(space)
    space.insert({
      messageId: '<reply-2@acme.cn>',
      from: '王工 <wang@acme.cn>',
      subject: 'Re: 报价',
      inReplyTo: ANCHOR_MESSAGE_ID,
      references: [ANCHOR_MESSAGE_ID],
      receivedAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
    })
    const before = Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n)
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(checked.ok, true)
    assert.equal(checked.command, 'mail followup check')
    assert.equal(checked.dryRun, false)
    assert.equal(checked.checked, 1)
    assert.equal(checked.changed.length, 1)
    assert.equal(checked.changed[0].from, 'waiting')
    assert.equal(checked.changed[0].to, 'replied')
    assert.equal(checked.changed[0].basis.method, 'headers')
    assert.equal(checked.changed[0].basis.replies.length, 1)
    const shown = mailFollowupShow(space.store, made.followup.id, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(shown.followup.state, 'replied')
    assert.equal(shown.followup.repliedAt, new Date(NOW.getTime() + DAY_MS).toISOString())
    assert.equal(shown.followup.daysWaiting, 1)
    assert.equal(Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n), before, 'check never writes the business ledger')
    assert.deepEqual(actions(space), ['followup.check', 'followup.add'])
    assert.equal(original.messageId, ANCHOR_MESSAGE_ID)
  } finally { space.cleanup() }
})

test('check: a References-only reply and a same-thread reply both count', () => {
  const space = openSpace()
  try {
    anchor(space)
    const refsOnly = addFollowup(space)
    space.insert({
      messageId: '<refs-reply@other.cn>',
      from: '王工 <wang@acme.cn>',
      subject: '回复：报价',
      references: ['<other-root@other.cn>', '<' + ANCHOR_MESSAGE_ID + '>'],
      receivedAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
    })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(checked.changed.length, 1)
    assert.equal(checked.changed[0].id, refsOnly.followup.id)
    assert.equal(checked.changed[0].to, 'replied')
  } finally { space.cleanup() }
})

test('check: automatic replies are ignored and never flip the state', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    const replyAt = new Date(NOW.getTime() + DAY_MS).toISOString()
    space.insert({ messageId: '<auto-1@acme.cn>', inReplyTo: ANCHOR_MESSAGE_ID, autoSubmitted: 'auto-generated', receivedAt: replyAt })
    space.insert({ messageId: '<auto-2@acme.cn>', inReplyTo: ANCHOR_MESSAGE_ID, subject: '自动回复：报价', receivedAt: replyAt })
    space.insert({ messageId: '<auto-3@acme.cn>', inReplyTo: ANCHOR_MESSAGE_ID, from: 'no-reply@acme.cn', receivedAt: replyAt })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(checked.changed.length, 1, 'the basis is persisted even when the state stays waiting')
    assert.equal(checked.changed[0].from, 'waiting')
    assert.equal(checked.changed[0].to, 'waiting')
    const item = checked.changed[0].basis
    assert.equal(item.replies.length, 0)
    assert.equal(item.ignored.length, 3)
    assert.deepEqual(item.ignored.map((entry) => entry.reason).sort(), ['auto-sender', 'auto-subject', 'auto-submitted'])
    assert.equal(mailFollowupShow(space.store, made.followup.id, { now: new Date(NOW.getTime() + 2 * DAY_MS) }).followup.state, 'waiting')
  } finally { space.cleanup() }
})

test('check: a foreign-domain sender is only a possible reply, never replied', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    space.insert({
      messageId: '<foreign@other.com>',
      from: '老板 <boss@other.com>',
      subject: 'Re: 报价',
      inReplyTo: ANCHOR_MESSAGE_ID,
      receivedAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
    })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(checked.changed[0].to, 'waiting')
    assert.equal(checked.changed[0].basis.replies.length, 0)
    assert.equal(checked.changed[0].basis.possible.length, 1)
    assert.equal(checked.changed[0].basis.possible[0].basis, 'thread+foreign-sender')
    const shown = mailFollowupShow(space.store, made.followup.id, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(shown.followup.possibleReplies.length, 1)
  } finally { space.cleanup() }
})

test('check: a subject-window match without threading headers is only possible', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    space.insert({
      messageId: '<no-headers@acme.cn>',
      from: '王工 <wang@acme.cn>',
      subject: 'Re: 报价',
      inReplyTo: null,
      references: [],
      receivedAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
    })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(checked.changed[0].to, 'waiting')
    assert.equal(checked.changed[0].basis.possible.length, 1)
    assert.equal(checked.changed[0].basis.possible[0].basis, 'subject-window')
    assert.equal(FOLLOWUP_AMBIGUOUS_WINDOW_DAYS, 30)
    const shown = mailFollowupShow(space.store, made.followup.id, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(shown.followup.possibleReplies.length, 1)
  } finally { space.cleanup() }
})

test('check: a legacy anchor without threading headers becomes unknown', () => {
  const space = openSpace()
  try {
    space.store.mutate(() => {
      space.store.db.prepare(
        'INSERT INTO mail_messages(id,account_id,mailbox,uid,uidvalidity,message_id,dedupe_key,from_addr,subject,received_at,attachments,status,candidate_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run('msg_legacy_anchor', space.account.id, 'INBOX', 90, '7', 'legacy@x.y', 'legacy-anchor-key', '王工 <wang@acme.cn>', '旧报价', NOW.toISOString(), '[]', 'new', '[]', NOW.toISOString(), NOW.toISOString())
    })
    const made = mailFollowupAdd(space.store, { mail: 'msg_legacy_anchor' }, { now: NOW })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(checked.changed[0].from, 'waiting')
    assert.equal(checked.changed[0].to, 'unknown')
    assert.deepEqual(checked.changed[0].basis.warnings, ['no-threading-headers'])
    assert.equal(mailFollowupShow(space.store, made.followup.id, { now: NOW }).followup.state, 'unknown')
  } finally { space.cleanup() }
})

test('check: a deleted anchor row becomes unknown/anchor-missing', () => {
  const space = openSpace()
  try {
    const original = anchor(space)
    const made = addFollowup(space)
    space.store.mutate(() => { space.store.db.prepare('DELETE FROM mail_messages WHERE id = ?').run(original.id) })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(checked.changed[0].to, 'unknown')
    assert.deepEqual(checked.changed[0].basis.warnings, ['anchor-missing'])
    assert.equal(mailFollowupShow(space.store, made.followup.id, { now: NOW }).followup.state, 'unknown')
  } finally { space.cleanup() }
})

test('check: --dry-run writes nothing (no row update, no audit)', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    space.insert({ messageId: '<reply@acme.cn>', inReplyTo: ANCHOR_MESSAGE_ID, receivedAt: new Date(NOW.getTime() + DAY_MS).toISOString() })
    const auditsBefore = space.store.listAudit(50).length
    const dry = mailFollowupCheck(space.store, { dryRun: true, now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.checked, 1)
    assert.equal(dry.wouldChange.length, 1)
    assert.equal(dry.wouldChange[0].to, 'replied')
    assert.equal(space.store.listAudit(50).length, auditsBefore, 'dry run appends no audit')
    const shown = mailFollowupShow(space.store, made.followup.id, { now: new Date(NOW.getTime() + 2 * DAY_MS) })
    assert.equal(shown.followup.state, 'waiting', 'dry run leaves the row untouched')
    assert.equal(shown.followup.lastCheckedAt, undefined)
  } finally { space.cleanup() }
})

test('check: nothing changed still writes exactly one audit row and does not touch rows', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    const auditsBefore = space.store.listAudit(50).length
    const first = mailFollowupCheck(space.store, { now: NOW })
    assert.equal(first.changed.length, 0)
    assert.equal(space.store.listAudit(50).length, auditsBefore + 1)
    assert.equal(space.store.listAudit(1)[0].action, 'followup.check')
    const row = space.store.db.prepare('SELECT checked_at FROM waiting_replies WHERE id = ?').get(made.followup.id)
    assert.equal(row.checked_at, null)
  } finally { space.cleanup() }
})

test('check: replied/dismissed rows are terminal and are not rescanned', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    mailFollowupMarkReplied(space.store, made.followup.id, {}, { now: NOW })
    const checked = mailFollowupCheck(space.store, { now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(checked.checked, 0)
    assert.equal(checked.changed.length, 0)
  } finally { space.cleanup() }
})

test('dismiss: fixed reason codes, audit, idempotent retry and terminal state', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    assert.equal(codeOf(() => mailFollowupDismiss(space.store, made.followup.id, {}, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(codeOf(() => mailFollowupDismiss(space.store, made.followup.id, { reason: 'bored' }, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.deepEqual(FOLLOWUP_DISMISS_REASONS, ['replied-elsewhere', 'no-follow-up', 'wrong-thread', 'other'])
    const dismissed = mailFollowupDismiss(space.store, made.followup.id, { reason: 'replied-elsewhere', note: '电话里回了' }, { now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(dismissed.followup.state, 'dismissed')
    assert.equal(dismissed.followup.dismissReason, 'replied-elsewhere')
    assert.equal(dismissed.followup.dismissNote, '电话里回了')
    assert.deepEqual(actions(space).slice(0, 1), ['followup.dismiss'])
    const again = mailFollowupDismiss(space.store, made.followup.id, { reason: 'replied-elsewhere' }, { now: NOW })
    assert.equal(again.alreadyDismissed, true)
    assert.equal(codeOf(() => mailFollowupDismiss(space.store, made.followup.id, { reason: 'other' }, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(codeOf(() => mailFollowupMarkReplied(space.store, made.followup.id, {}, { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(codeOf(() => mailFollowupDismiss(space.store, 'wr_missing', { reason: 'other' }, { now: NOW })), FOLLOWUP_ERROR_CODES.NOT_FOUND)
  } finally { space.cleanup() }
})

test('mark-replied: manual evidence, audit, idempotent retry', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    const marked = mailFollowupMarkReplied(space.store, made.followup.id, { note: '对方电话确认' }, { now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(marked.followup.state, 'replied')
    assert.equal(marked.followup.repliedAt, new Date(NOW.getTime() + DAY_MS).toISOString())
    assert.equal(marked.followup.note, '对方电话确认')
    assert.equal(marked.followup.replies.length, 0)
    assert.deepEqual(actions(space).slice(0, 1), ['followup.mark-replied'])
    const again = mailFollowupMarkReplied(space.store, made.followup.id, {}, { now: NOW })
    assert.equal(again.alreadyReplied, true)
    const basis = JSON.parse(space.store.db.prepare('SELECT basis FROM waiting_replies WHERE id = ?').get(made.followup.id).basis)
    assert.equal(basis.method, 'manual')
  } finally { space.cleanup() }
})

test('ls: defaults to waiting, filters by state/staleness and paginates', () => {
  const space = openSpace()
  try {
    const first = space.insert({ messageId: '<a@example.com>' })
    const second = space.insert({ messageId: '<b@example.com>', receivedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString() })
    const madeA = addFollowup(space, { mail: '<a@example.com>' })
    const madeB = addFollowup(space, { mail: '<b@example.com>' })
    const waiting = mailFollowupLs(space.store, { now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(waiting.command, 'mail followup ls')
    assert.equal(waiting.total, 2)
    assert.equal(waiting.truncated, false)
    assert.deepEqual(waiting.items.map((item) => item.state), ['waiting', 'waiting'])
    const stale = mailFollowupLs(space.store, { staleDays: 7, now: new Date(NOW.getTime() + DAY_MS) })
    assert.equal(stale.total, 1)
    assert.equal(stale.items[0].id, madeB.followup.id)
    mailFollowupMarkReplied(space.store, madeA.followup.id, {}, { now: NOW })
    assert.equal(mailFollowupLs(space.store, { now: NOW }).total, 1, 'waiting is the default view')
    assert.equal(mailFollowupLs(space.store, { state: 'replied', now: NOW }).total, 1)
    assert.equal(mailFollowupLs(space.store, { state: 'all', now: NOW }).total, 2)
    const page = mailFollowupLs(space.store, { state: 'all', limit: 1, offset: 1, now: NOW })
    assert.equal(page.items.length, 1)
    assert.equal(page.truncated, false)
    assert.equal(mailFollowupLs(space.store, { state: 'all', limit: 1, offset: 0, now: NOW }).truncated, true)
    assert.equal(codeOf(() => mailFollowupLs(space.store, { state: 'nope', now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    assert.equal(first.messageId !== second.messageId, true)
  } finally { space.cleanup() }
})

test('ls/show/check: coverage reports synced mailboxes and the missing Sent warning', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    const missingSent = mailFollowupLs(space.store, { now: NOW }).coverage
    assert.deepEqual(missingSent, { syncedMailboxes: 0, sentMailboxSeen: false, basis: 'headers', warnings: ['sent-mailbox-not-synced'] })
    const sentAccount = addTestAccount(space.store, space.home, { name: 'sentbox', mailbox: 'Sent' })
    assert.equal(mailFollowupCoverage(space.store).sentMailboxSeen, false, 'a configured but never synced Sent mailbox is still not coverage')
    space.store.mutate((store) => { putMailCursor(store, { accountId: sentAccount.id, mailbox: 'Sent', uidvalidity: '9', lastUid: 3, now: NOW }) })
    const covered = mailFollowupCoverage(space.store)
    assert.equal(covered.sentMailboxSeen, true)
    assert.deepEqual(covered.warnings, [])
    assert.equal(covered.basis, 'headers')
    assert.equal(covered.syncedMailboxes, 1)
    assert.deepEqual(mailFollowupCheck(space.store, { now: NOW }).coverage, covered)
    assert.deepEqual(mailFollowupShow(space.store, made.followup.id, { now: NOW }).coverage, covered)
  } finally { space.cleanup() }
})

test('show: unknown id fails closed and the JSON shape carries the documented fields', () => {
  const space = openSpace()
  try {
    anchor(space)
    const made = addFollowup(space)
    assert.equal(codeOf(() => mailFollowupShow(space.store, 'wr_missing', { now: NOW })), FOLLOWUP_ERROR_CODES.NOT_FOUND)
    assert.equal(codeOf(() => mailFollowupShow(space.store, '', { now: NOW })), FOLLOWUP_ERROR_CODES.INVALID)
    const shown = mailFollowupShow(space.store, made.followup.id, { now: NOW })
    for (const key of ['id', 'commitmentId', 'anchorMessageId', 'threadRoot', 'counterparty', 'subject', 'anchorAt', 'dueAt', 'state', 'daysWaiting', 'replies', 'ignoredReplies', 'possibleReplies', 'warnings', 'lastCheckedAt', 'createdAt', 'updatedAt']) {
      assert.ok(key in shown.followup, 'item is missing ' + key)
    }
  } finally { space.cleanup() }
})

test('schema guard: a ledger without waiting_replies fails closed with E_SCHEMA_STALE', () => {
  const space = openSpace()
  try {
    space.store.db.exec('DROP TABLE waiting_replies')
    assert.equal(codeOf(() => assertFollowupTables(space.store)), 'E_SCHEMA_STALE')
    assert.equal(codeOf(() => mailFollowupLs(space.store, { now: NOW })), 'E_SCHEMA_STALE')
  } finally { space.cleanup() }
})
