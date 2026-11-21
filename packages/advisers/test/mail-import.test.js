import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  mailAccountList, mailAccountRemove, mailDismiss, mailExtract, mailImport, mailLink,
  mailList, mailPurge, mailShow,
} from '../lib/mail.js'
import { makeEml, makeEmlWithAttachment, openMailStore, writeEml } from './mail-fixture.js'

const NOW = new Date('2026-11-20T02:00:00.000Z')
const OLD = 'Thu, 12 Nov 2026 09:00:00 +0800'

function count(store, table) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
}

test('mail import: a .eml directory is imported offline with attachment metadata and Message-ID dedupe', async () => {
  const space = openMailStore()
  const directory = join(space.root, 'mail')
  mkdirSync(directory)
  try {
    writeEml(directory, 'a.eml', makeEml({ messageId: '<a@example.com>', subject: '报价 A', date: OLD, body: '我周五前把报价发给你。' }))
    writeEml(directory, 'b.eml', makeEmlWithAttachment({ messageId: '<b@example.com>' }))
    writeEml(directory, 'ignored.txt', 'not mail')
    const originalFetch = globalThis.fetch
    globalThis.fetch = () => { throw new Error('mail import must never use the network') }
    try {
      const result = await mailImport(space.store, { path: directory, now: NOW })
      assert.equal(result.ok, true)
      assert.equal(result.command, 'mail import')
      assert.equal(result.files, 2)
      assert.equal(result.inserted, 2)
      assert.equal(result.skipped, 0)
      const second = await mailImport(space.store, { path: directory, now: NOW })
      assert.equal(second.inserted, 0)
      assert.equal(second.skipped, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(count(space.store, 'mail_messages'), 2)
    const messages = mailList(space.store, {}).messages
    assert.equal(messages.length, 2)
    const withAttachment = messages.find((message) => message.messageId === 'b@example.com')
    assert.deepEqual(withAttachment.attachments, [{ name: 'quote.pdf', size: 17, mime: 'application/pdf' }])
    assert.equal(withAttachment.uidvalidity, 'local')
    const accounts = mailAccountList(space.store, { home: space.home })
    assert.equal(accounts.total, 1)
    assert.equal(accounts.accounts[0].id, 'acct_local_eml')
    const shown = mailShow(space.store, '<a@example.com>', { body: true })
    assert.equal(shown.message.clientId, undefined)
    assert.match(shown.message.bodyText, /我周五前把报价发给你/)
  } finally { space.cleanup() }
})

test('mail import: mbox streams are split into messages and empty bodies are skipped, not stored', async () => {
  const space = openMailStore()
  try {
    const mbox = [
      'From sender@example.com Thu Nov 12 09:00:00 2026',
      makeEml({ messageId: '<mbox-1@example.com>', body: '我周五前发报价。' }),
      'From sender@example.com Thu Nov 12 10:00:00 2026',
      makeEml({ messageId: '<mbox-2@example.com>', body: '' }),
      'From sender@example.com Thu Nov 12 11:00:00 2026',
      makeEml({ messageId: '<mbox-3@example.com>', subject: '第二封', body: '我周一前发合同。' }),
    ].join('\r\n')
    const file = writeEml(space.root, 'all.mbox', mbox)
    const result = await mailImport(space.store, { path: file, now: NOW })
    assert.equal(result.files, 1)
    assert.equal(result.scanned, 3)
    assert.equal(result.inserted, 2)
    assert.equal(result.skipped, 1)
    assert.deepEqual(mailList(space.store, {}).messages.map((message) => message.subject).sort(), ['报价', '第二封'].sort())
    const uids = space.store.db.prepare('SELECT uid FROM mail_messages ORDER BY uid').all().map((row) => Number(row.uid))
    assert.deepEqual(uids, [1, 2])
  } finally { space.cleanup() }
})

test('mail import --dry-run reports counts without writing rows or creating the local account', async () => {
  const space = openMailStore()
  const directory = join(space.root, 'mail')
  mkdirSync(directory)
  try {
    writeEml(directory, 'a.eml', makeEml({ messageId: '<dry@example.com>' }))
    const result = await mailImport(space.store, { path: directory, dryRun: true, now: NOW })
    assert.equal(result.dryRun, true)
    assert.equal(result.inserted, 0)
    assert.equal(result.scanned, 1)
    assert.equal(count(space.store, 'mail_messages'), 0)
    assert.equal(mailAccountList(space.store, { home: space.home }).total, 0)
  } finally { space.cleanup() }
})

test('mail list/show: filters, pagination, message-id lookup and unknown ids', async () => {
  const space = openMailStore()
  const directory = join(space.root, 'mail')
  mkdirSync(directory)
  try {
    writeEml(directory, 'a.eml', makeEml({ messageId: '<l1@example.com>', subject: '一号', date: OLD, body: '我周五前发报价。' }))
    writeEml(directory, 'b.eml', makeEml({ messageId: '<l2@example.com>', subject: '二号', date: OLD, body: '我周一前发合同。' }))
    await mailImport(space.store, { path: directory, clientId: 'cl_test', now: NOW })
    const all = mailList(space.store, {})
    assert.equal(all.total, 2)
    assert.equal(all.truncated, false)
    const one = mailList(space.store, { limit: 1 })
    assert.equal(one.messages.length, 1)
    assert.equal(one.truncated, true)
    const byClient = mailList(space.store, { clientId: 'cl_test' })
    assert.equal(byClient.total, 2)
    assert.equal(byClient.messages[0].clientId, 'cl_test')
    assert.equal(mailList(space.store, { clientId: 'cl_other' }).total, 0)
    assert.equal(mailList(space.store, { sinceDays: 1, now: NOW }).total, 0, 'OLD messages are outside a 1-day window')
    assert.equal(mailList(space.store, { status: 'new' }).total, 2)
    const byId = mailShow(space.store, '<l2@example.com>')
    assert.equal(byId.message.subject, '二号')
    assert.equal(byId.message.retained, true)
    assert.throws(() => mailShow(space.store, 'msg_missing'), (error) => error.code === 'E_MAIL_MESSAGE_NOT_FOUND')
  } finally { space.cleanup() }
})

test('mail link/dismiss are manual review helpers and keep messages out of the new-extraction scan', async () => {
  const space = openMailStore()
  const directory = join(space.root, 'mail')
  mkdirSync(directory)
  try {
    writeEml(directory, 'a.eml', makeEml({ messageId: '<link@example.com>', body: '我周五前发报价。' }))
    await mailImport(space.store, { path: directory, now: NOW })
    const message = mailList(space.store, {}).messages[0]
    const linked = mailLink(space.store, message.id, { clientId: 'cl_1', projectId: 'pr_1', now: NOW })
    assert.equal(linked.message.clientId, 'cl_1')
    assert.equal(linked.message.projectId, 'pr_1')
    assert.equal(linked.message.status, 'linked')
    const dismissed = mailDismiss(space.store, message.id, { now: NOW })
    assert.equal(dismissed.message.status, 'dismissed')
    const audit = space.store.db.prepare("SELECT action FROM audit WHERE action IN ('mail.link','mail.dismiss') ORDER BY seq").all().map((row) => row.action)
    assert.deepEqual(audit, ['mail.link', 'mail.dismiss'])
    const extract = await mailExtract(space.store, { now: NOW })
    assert.equal(extract.scanned, 0, 'dismissed/linked messages are not re-extracted by default')
  } finally { space.cleanup() }
})

test('mail purge: pending candidates protect the body; purging keeps metadata, hash and dedupe (no re-import)', async () => {
  const space = openMailStore()
  try {
    const file = writeEml(space.root, 'old.eml', makeEml({ messageId: '<purge@example.com>', date: OLD, body: '我周五前把报价发给你。' }))
    await mailImport(space.store, { path: file, now: NOW })
    const message = mailList(space.store, {}).messages[0]
    assert.equal(message.retained, true)
    const extract = await mailExtract(space.store, { now: NOW })
    assert.equal(extract.candidates.length, 1)
    const candidateId = extract.candidates[0].id
    const dry = mailPurge(space.store, { olderThanDays: 0, dryRun: true, now: NOW })
    assert.equal(dry.wouldPurge, 0)
    assert.equal(dry.skippedPending, 1)
    const skipped = mailPurge(space.store, { olderThanDays: 0, now: NOW })
    assert.equal(skipped.messagesPurged, 0)
    assert.equal(skipped.skippedPending, 1)
    assert.match(mailShow(space.store, message.id, { body: true }).message.bodyText, /我周五前把报价发给你/)
    space.store.mutate(() => space.store.reviewCandidate(candidateId, 'rejected'))
    const purged = mailPurge(space.store, { olderThanDays: 0, now: NOW })
    assert.equal(purged.messagesPurged, 1)
    assert.ok(purged.bytesFreed > 0)
    assert.equal(count(space.store, 'mail_messages'), 1, 'the message row survives retention')
    const after = mailList(space.store, {}).messages[0]
    assert.equal(after.retained, false)
    assert.ok(after.purgedAt)
    assert.match(after.bodySha256, /^[0-9a-f]{64}$/)
    assert.equal(after.dedupeKey.length, 64)
    assert.throws(() => mailShow(space.store, message.id, { body: true }), (error) => error.code === 'E_MAIL_NOT_RETAINED')
    // Re-importing the same file after purge does not recreate a second row.
    const reimport = await mailImport(space.store, { path: join(space.root, 'old.eml'), now: NOW })
    assert.equal(reimport.inserted, 0)
    assert.equal(count(space.store, 'mail_messages'), 1)
  } finally { space.cleanup() }
})

test('mail purge: account retention window is honoured (no purge of recent bodies)', async () => {
  const space = openMailStore()
  try {
    // Header date is 8 days before NOW, default retention is 30 days.
    const file = writeEml(space.root, 'recent.eml', makeEml({ messageId: '<recent@example.com>', date: OLD, body: '我周五前发报价。' }))
    await mailImport(space.store, { path: file, now: NOW })
    const dry = mailPurge(space.store, { dryRun: true, now: NOW })
    assert.equal(dry.wouldPurge, 0)
    assert.equal(dry.skippedPending, 0)
    const result = mailPurge(space.store, { now: NOW })
    assert.equal(result.messagesPurged, 0)
    assert.equal(count(space.store, 'mail_messages'), 1)
    assert.equal(mailList(space.store, {}).messages[0].retained, true)
  } finally { space.cleanup() }
})

test('mail account remove --purge-messages deletes mail rows and the local account tombstone stays', async () => {
  const space = openMailStore()
  const directory = join(space.root, 'mail')
  mkdirSync(directory)
  try {
    writeEml(directory, 'a.eml', makeEml({ messageId: '<rm@example.com>' }))
    await mailImport(space.store, { path: directory, now: NOW })
    const result = mailAccountRemove(space.store, 'acct_local_eml', { home: space.home, purgeMessages: true })
    assert.equal(result.removed, true)
    assert.equal(result.credentialRemoved, false)
    assert.equal(result.messagesDeleted, 1)
    assert.equal(count(space.store, 'mail_messages'), 0)
    assert.equal(mailAccountList(space.store, { home: space.home }).total, 0)
  } finally { space.cleanup() }
})
