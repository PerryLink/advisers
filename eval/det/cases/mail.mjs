/**
 * 0.4.0 mail deterministic gate: offline .eml import -> mail ls / show and the
 * default local extraction path.
 *
 * The fixture .eml has a fixed Date and Message-ID header, so sentAt /
 * receivedAt / id / dedupeKey / bodySha256 are deterministic; only the
 * home-local createdAt/updatedAt row metadata uses the wall clock, and it is
 * compared only within the same home. Every child runs behind the
 * network-block preload: the local import/extract path must never touch IMAP,
 * a provider or any other socket.
 */
import { check, controlViolations } from '../lib/harness.mjs'
import { checkNoNetwork, isSha256, jsonValue, runJsonCli, writeWorkFile, withFreshHome } from './_fixture.mjs'

const EML_SAMPLE = [
  'From: Wang Gong <wang@example.com>',
  'To: me@example.com',
  'Subject: 官网改版报价',
  'Date: Fri, 20 Nov 2026 09:00:00 +0800',
  'Message-ID: <fixed-mail-1@example.com>',
  'Content-Type: text/plain; charset=UTF-8',
  'MIME-Version: 1.0',
  '',
  '王工你好：',
  '',
  '我将在 2026-11-25 前发出报价单，请查收。',
  '',
  '谢谢。',
  '',
].join('\n')

const MESSAGE_ID = 'fixed-mail-1@example.com'
const SENT_AT = '2026-11-20T01:00:00.000Z'

function stableMessageFields(message) {
  return {
    id: message.id,
    accountId: message.accountId,
    messageId: message.messageId,
    dedupeKey: message.dedupeKey,
    from: message.from,
    subject: message.subject,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    sizeBytes: message.sizeBytes,
    bodySha256: message.bodySha256,
  }
}

export default [
  {
    id: 'det.mail.import-ls-show-deterministic',
    group: 'mail',
    title: 'offline .eml import -> ls/show: fixed headers, byte-stable reads, duplicate-safe',
    async run() {
      return withFreshHome('mail-import', async (workdir) => {
        const checks = []
        const runs = []
        writeWorkFile(workdir, 'sample.eml', EML_SAMPLE)

        const import1 = runJsonCli(workdir, ['mail', 'import', 'sample.eml', '--json'], { index: 'mail-import-1' })
        runs.push(import1.run)
        check(checks, 'import.exit-0', () => {
          if (import1.run.status !== 0) throw new Error('exit ' + import1.run.status + ': ' + import1.run.stderr.slice(0, 200))
        })
        check(checks, 'import.offline-envelope', () => {
          const value = jsonValue(import1, 'mail import')
          if (value.command !== 'mail import') throw new Error('command=' + value.command)
          if (value.accountId !== 'acct_local_eml') throw new Error('accountId=' + value.accountId)
          if (value.files !== 1 || value.scanned !== 1 || value.inserted !== 1 || value.skipped !== 0 || value.failed !== 0) throw new Error(JSON.stringify(value))
          if (value.dryRun !== false) throw new Error('dryRun=' + value.dryRun)
        })
        check(checks, 'import.stderr-empty', () => {
          if (import1.run.stderr !== '') throw new Error(JSON.stringify(import1.run.stderr.slice(0, 200)))
        })

        const import2 = runJsonCli(workdir, ['mail', 'import', 'sample.eml', '--json'], { index: 'mail-import-2' })
        runs.push(import2.run)
        check(checks, 'import.duplicate-is-skip-level', () => {
          if (import2.run.status !== 0) throw new Error('exit ' + import2.run.status + ': ' + import2.run.stderr.slice(0, 200))
          const value = jsonValue(import2, 'mail import (duplicate)')
          if (value.inserted !== 0 || value.skipped !== 1 || value.failed !== 0) throw new Error(JSON.stringify(value))
        })

        const ls1 = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'mail-ls-1' })
        const ls2 = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'mail-ls-2' })
        runs.push(ls1.run, ls2.run)
        check(checks, 'ls.exit-0', () => {
          if (ls1.run.status !== 0 || ls2.run.status !== 0) throw new Error('exit ' + ls1.run.status + '/' + ls2.run.status + ': ' + ls1.run.stderr.slice(0, 200))
        })
        check(checks, 'ls.bytes-identical', () => {
          if (ls1.run.stdout !== ls2.run.stdout) throw new Error('mail ls differs between two runs in the same home')
        })
        const listed = jsonValue(ls1, 'mail ls').messages?.[0]
        check(checks, 'ls.message-contract', () => {
          const value = jsonValue(ls1, 'mail ls')
          if (value.total !== 1 || (value.messages ?? []).length !== 1) throw new Error('total=' + value.total)
          const message = value.messages[0]
          if (!/^msg_[0-9a-f]{32}$/.test(String(message.id))) throw new Error('id=' + message.id)
          if (message.accountId !== 'acct_local_eml' || message.mailbox !== 'local') throw new Error('account/mailbox=' + message.accountId + '/' + message.mailbox)
          if (message.messageId !== MESSAGE_ID) throw new Error('messageId=' + message.messageId)
          if (message.from !== 'Wang Gong <wang@example.com>') throw new Error('from=' + message.from)
          if (message.subject !== '官网改版报价') throw new Error('subject=' + message.subject)
          if (message.sentAt !== SENT_AT || message.receivedAt !== SENT_AT) throw new Error('sentAt/receivedAt=' + message.sentAt + '/' + message.receivedAt)
          if (message.retained !== true || message.status !== 'new') throw new Error('retained/status=' + message.retained + '/' + message.status)
          if (!Array.isArray(message.attachments) || message.attachments.length !== 0) throw new Error('attachments=' + JSON.stringify(message.attachments))
          if (!Array.isArray(message.candidateIds) || message.candidateIds.length !== 0) throw new Error('candidateIds=' + JSON.stringify(message.candidateIds))
          if (!isSha256(message.bodySha256)) throw new Error('bodySha256=' + message.bodySha256)
          if (!/^[0-9a-f]{64}$/.test(String(message.dedupeKey))) throw new Error('dedupeKey=' + message.dedupeKey)
          if (Object.prototype.hasOwnProperty.call(message, 'bodyText')) throw new Error('mail ls exposed the body')
        })
        check(checks, 'ls.stdout-no-control-bytes', () => {
          const violations = controlViolations(ls1.run.stdout)
          if (violations.length) throw new Error(violations.join(','))
        })

        const messageId = listed?.id ?? 'msg_missing'
        const show1 = runJsonCli(workdir, ['mail', 'show', messageId, '--json'], { index: 'mail-show-1' })
        const show2 = runJsonCli(workdir, ['mail', 'show', messageId, '--json'], { index: 'mail-show-2' })
        runs.push(show1.run, show2.run)
        check(checks, 'show.bytes-identical-and-body-free', () => {
          if (show1.run.status !== 0 || show2.run.status !== 0) throw new Error('exit ' + show1.run.status + '/' + show2.run.status)
          if (show1.run.stdout !== show2.run.stdout) throw new Error('mail show differs between two runs')
          const message = jsonValue(show1, 'mail show').message ?? {}
          if (message.id !== messageId) throw new Error('id=' + message.id)
          if (Object.prototype.hasOwnProperty.call(message, 'bodyText')) throw new Error('mail show without --body exposed the body')
        })
        const body1 = runJsonCli(workdir, ['mail', 'show', messageId, '--body', '--json'], { index: 'mail-show-body-1' })
        const body2 = runJsonCli(workdir, ['mail', 'show', messageId, '--body', '--json'], { index: 'mail-show-body-2' })
        runs.push(body1.run, body2.run)
        check(checks, 'show.body-opt-in-and-stable', () => {
          if (body1.run.status !== 0 || body2.run.status !== 0) throw new Error('exit ' + body1.run.status + '/' + body2.run.status)
          if (body1.run.stdout !== body2.run.stdout) throw new Error('mail show --body differs between two runs')
          const text = jsonValue(body1, 'mail show --body').message?.bodyText
          if (typeof text !== 'string' || !text.includes('我将在 2026-11-25 前发出报价单')) throw new Error('bodyText=' + JSON.stringify(text))
        })

        await withFreshHome('mail-import-second', async (second) => {
          writeWorkFile(second, 'sample.eml', EML_SAMPLE)
          const importSecond = runJsonCli(second, ['mail', 'import', 'sample.eml', '--json'], { index: 'mail-import-second' })
          const lsSecond = runJsonCli(second, ['mail', 'ls', '--json'], { index: 'mail-ls-second' })
          runs.push(importSecond.run, lsSecond.run)
          check(checks, 'cross-home.stable-message-fields', () => {
            const left = stableMessageFields(listed ?? {})
            const right = stableMessageFields(jsonValue(lsSecond, 'mail ls (second home)').messages?.[0] ?? {})
            if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(JSON.stringify(left) + ' != ' + JSON.stringify(right))
          })
        })

        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.mail.local-extract-deterministic',
    group: 'mail',
    title: 'local extraction: dry-run is byte-stable; one explicit run creates a pending candidate',
    async run() {
      return withFreshHome('mail-extract', async (workdir) => {
        const checks = []
        const runs = []
        writeWorkFile(workdir, 'sample.eml', EML_SAMPLE)
        const imported = runJsonCli(workdir, ['mail', 'import', 'sample.eml', '--json'], { index: 'mail-extract-import' })
        runs.push(imported.run)
        check(checks, 'import.exit-0-and-inserted', () => {
          if (imported.run.status !== 0) throw new Error('exit ' + imported.run.status + ': ' + imported.run.stderr.slice(0, 200))
          const value = jsonValue(imported, 'mail import')
          if (value.inserted !== 1) throw new Error('inserted=' + value.inserted)
        })

        const dry1 = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--local', '--dry-run', '--json'], { index: 'mail-extract-dry-1' })
        const dry2 = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--local', '--dry-run', '--json'], { index: 'mail-extract-dry-2' })
        runs.push(dry1.run, dry2.run)
        check(checks, 'dry-run.exit-0', () => {
          if (dry1.run.status !== 0 || dry2.run.status !== 0) throw new Error('exit ' + dry1.run.status + '/' + dry2.run.status + ': ' + dry1.run.stderr.slice(0, 200))
        })
        check(checks, 'dry-run.bytes-identical', () => {
          if (dry1.run.stdout !== dry2.run.stdout) throw new Error('mail extract --dry-run differs between two runs')
        })
        check(checks, 'dry-run.local-preview-shape', () => {
          const value = jsonValue(dry1, 'mail extract --dry-run')
          if (value.mode !== 'local' || value.dryRun !== true) throw new Error('mode/dryRun=' + value.mode + '/' + value.dryRun)
          if (value.scanned !== 1) throw new Error('scanned=' + value.scanned)
          const candidates = value.candidates ?? []
          if (candidates.length !== 1) throw new Error('candidates=' + candidates.length)
          const candidate = candidates[0]
          if (candidate.preview !== true) throw new Error('preview=' + candidate.preview)
          if (candidate.id !== undefined) throw new Error('dry-run leaked a persisted candidate id: ' + candidate.id)
          if (candidate.kind !== 'commitment') throw new Error('kind=' + candidate.kind)
          if (candidate.payload?.debtor !== 'user') throw new Error('debtor=' + candidate.payload?.debtor)
          if (candidate.payload?.creditor !== 'Wang Gong') throw new Error('creditor=' + candidate.payload?.creditor)
          if (candidate.payload?.dueAt !== '2026-11-25T10:00:00.000Z') throw new Error('dueAt=' + candidate.payload?.dueAt)
          const evidence = candidate.evidence?.[0] ?? {}
          if (typeof evidence.quote !== 'string' || !evidence.quote.includes('报价单')) throw new Error('quote=' + JSON.stringify(evidence.quote))
          if (evidence.source?.type !== 'mail') throw new Error('source.type=' + evidence.source?.type)
          if (!/^eml:acct_local_eml:msg_[0-9a-f]{32}$/.test(String(evidence.source?.ref))) throw new Error('source.ref=' + evidence.source?.ref)
          if (evidence.source?.messageId !== MESSAGE_ID) throw new Error('source.messageId=' + evidence.source?.messageId)
          if (evidence.source?.capturedAt !== SENT_AT) throw new Error('source.capturedAt=' + evidence.source?.capturedAt)
        })

        const actual = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--local', '--json'], { index: 'mail-extract-run' })
        runs.push(actual.run)
        const candidate = (jsonValue(actual, 'mail extract')?.candidates ?? [])[0]
        check(checks, 'extract.one-pending-candidate', () => {
          if (actual.run.status !== 0) throw new Error('exit ' + actual.run.status + ': ' + actual.run.stderr.slice(0, 200))
          const value = jsonValue(actual, 'mail extract')
          if (value.mode !== 'local' || value.dryRun !== false) throw new Error('mode/dryRun=' + value.mode + '/' + value.dryRun)
          if (value.scanned !== 1 || value.failed !== 0) throw new Error('scanned/failed=' + value.scanned + '/' + value.failed)
          const candidates = value.candidates ?? []
          if (candidates.length !== 1) throw new Error('candidates=' + candidates.length)
          if (!/^cand_/.test(String(candidates[0].id))) throw new Error('candidate id=' + candidates[0].id)
          if (candidates[0].kind !== 'commitment' || candidates[0].status !== 'pending') throw new Error('kind/status=' + candidates[0].kind + '/' + candidates[0].status)
        })

        const ls1 = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'mail-extract-ls-1' })
        const ls2 = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'mail-extract-ls-2' })
        runs.push(ls1.run, ls2.run)
        check(checks, 'ls.marks-extracted-and-stable', () => {
          if (ls1.run.status !== 0 || ls2.run.status !== 0) throw new Error('exit ' + ls1.run.status + '/' + ls2.run.status)
          if (ls1.run.stdout !== ls2.run.stdout) throw new Error('mail ls after extraction differs between two runs')
          const message = jsonValue(ls1, 'mail ls').messages?.[0] ?? {}
          if (message.status !== 'extracted') throw new Error('status=' + message.status)
          if ((message.candidateIds ?? []).length !== 1 || message.candidateIds[0] !== candidate?.id) throw new Error('candidateIds=' + JSON.stringify(message.candidateIds) + ' candidate=' + candidate?.id)
        })

        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
]
