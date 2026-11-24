/**
 * 0.5.1 (051-S5, plan 92 section 4): `mail followup add|ls|show|check|dismiss|mark-replied`.
 *
 * Drives the real bin with threaded .eml boundaries: an auto-reply is ignored, a
 * foreign-sender thread hit is only `possibleReplies`, a genuine same-thread reply
 * flips waiting -> replied, and the Sent-mailbox warning is always surfaced.
 * Also covers dismiss/mark-replied/idempotency/usage exits and the TOS gate.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }
const TOS = { ADVISERS_ACCEPT_TOS: '1' }

function makeRoot() { return mkdtempSync(join(tmpdir(), 'advisers-051-followup-')) }
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home, ...extra },
    encoding: 'utf8', input: '', timeout: 120000,
  })
}
function ok(result, label) {
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout))
  return result
}
function json(result) {
  try { return JSON.parse(result.stdout) }
  catch (error) { throw new Error('not JSON: ' + result.stdout.slice(0, 400) + ' / ' + result.stderr) }
}
function stderrJson(result) {
  try { return JSON.parse(result.stderr.trim().split('\n').pop()) }
  catch (error) { throw new Error('stderr is not JSON: ' + result.stderr.slice(0, 400)) }
}

/** Minimal RFC 5322 fixture: only the headers the thread rules read. */
function eml({ from, subject, messageId, date, body = '', headers = [] }) {
  return ['From: ' + from, 'To: me@example.com', 'Subject: ' + subject, 'Date: ' + date, 'Message-ID: ' + messageId, ...headers].join('\r\n')
    + '\r\n\r\n' + body + '\r\n'
}
function writeEml(dir, name, content) { writeFileSync(join(dir, name), content) }
function seed(home) { ok(run(home, ['init'], TOS), 'init') }
function importDir(home, dir) { ok(run(home, ['mail', 'import', dir, '--json'], TOS), 'mail import') }

const ANCHOR = {
  from: '王工 <wang@acme.cn>',
  subject: '报价请求',
  messageId: '<m1@acme.cn>',
  date: 'Thu, 12 Nov 2026 10:00:00 +0800',
  body: '请把报价发我。',
}

function anchorHome(root, anchor = ANCHOR) {
  const home = join(root, 'home')
  const emlDir = join(root, 'eml')
  mkdirSync(emlDir, { recursive: true })
  seed(home)
  writeEml(emlDir, 'anchor.eml', eml(anchor))
  importDir(home, emlDir)
  return { home, emlDir }
}
function addFollowup(home, messageId, counterparty = 'wang@acme.cn') {
  return json(ok(run(home, ['mail', 'followup', 'add', '--mail', messageId, '--counterparty', counterparty, '--json'], TOS), 'followup add'))
}

test('followup boundaries: auto-reply ignored, foreign sender only possible, genuine reply flips to replied', () => {
  const root = makeRoot()
  try {
    const { home, emlDir } = anchorHome(root)
    const added = addFollowup(home, '<m1@acme.cn>')
    assert.equal(added.ok, true)
    assert.equal(added.command, 'mail followup add')
    assert.match(added.followup.id, /^wr_/)
    assert.match(added.commitment.id, /^cm_/)
    assert.equal(added.followup.state, 'waiting')
    assert.equal(added.followup.anchorMessageId, 'm1@acme.cn')
    assert.equal(added.dueBasis, 'waiting-default')
    assert.ok(added.followup.dueAt, 'the default due is anchor + 3 days')

    const ls = json(ok(run(home, ['mail', 'followup', 'ls', '--json'], TOS), 'followup ls'))
    assert.equal(ls.total, 1)
    assert.equal(ls.coverage.sentMailboxSeen, false, 'a local .eml import has no Sent mailbox')
    assert.ok(ls.coverage.warnings.includes('sent-mailbox-not-synced'))
    assert.equal(ls.items[0].state, 'waiting')

    const shown = json(ok(run(home, ['mail', 'followup', 'show', added.followup.id, '--json'], TOS), 'followup show'))
    assert.equal(shown.followup.id, added.followup.id)
    assert.ok(shown.coverage)

    // Auto-reply (ignored) and foreign-sender reply (possible only), both threaded.
    writeEml(emlDir, 'auto.eml', eml({
      from: '王工 <wang@acme.cn>', subject: '自动回复: 报价请求', messageId: '<m3@acme.cn>',
      date: 'Fri, 13 Nov 2026 11:00:00 +0800', body: '我休假中。',
      headers: ['In-Reply-To: <m1@acme.cn>', 'Auto-Submitted: auto-replied'],
    }))
    writeEml(emlDir, 'foreign.eml', eml({
      from: '李四 <li@other.cn>', subject: 'Re: 报价请求', messageId: '<m4@other.cn>',
      date: 'Fri, 13 Nov 2026 12:00:00 +0800', body: '转发一下。',
      headers: ['In-Reply-To: <m1@acme.cn>', 'References: <m1@acme.cn>'],
    }))
    importDir(home, emlDir)
    // A real check refreshes the stored basis even when the state stays waiting;
    // show/ls read that stored basis rather than re-evaluating on every read.
    ok(run(home, ['mail', 'followup', 'check', '--json'], TOS), 'check after ignored')
    const afterIgnored = json(ok(run(home, ['mail', 'followup', 'show', added.followup.id, '--json'], TOS), 'show after ignored'))
    assert.equal(afterIgnored.followup.ignoredReplies.length, 1, 'the auto-reply is ignored')
    assert.equal(afterIgnored.followup.possibleReplies.length, 1, 'the foreign sender is possible only')
    assert.equal(afterIgnored.followup.replies.length, 0)
    assert.equal(afterIgnored.followup.state, 'waiting', 'neither may flip the state automatically')

    const dry = json(ok(run(home, ['mail', 'followup', 'check', '--dry-run', '--json'], TOS), 'check dry-run'))
    assert.equal(dry.dryRun, true)
    assert.equal(dry.checked, 1)
    assert.equal((dry.wouldChange ?? []).filter((change) => change.to === 'replied').length, 0)
    const stillWaiting = json(ok(run(home, ['mail', 'followup', 'ls', '--json'], TOS), 'ls after dry-run'))
    assert.equal(stillWaiting.items[0].state, 'waiting')

    // A genuine same-thread reply from the counterparty is the only auto flip.
    writeEml(emlDir, 'reply.eml', eml({
      from: '王工 <wang@acme.cn>', subject: 'Re: 报价请求', messageId: '<m2@acme.cn>',
      date: 'Fri, 13 Nov 2026 10:00:00 +0800', body: '收到，明天给你答复。',
      headers: ['In-Reply-To: <m1@acme.cn>', 'References: <m1@acme.cn>'],
    }))
    importDir(home, emlDir)
    const dryReply = json(ok(run(home, ['mail', 'followup', 'check', '--dry-run', '--json'], TOS), 'check dry-run with reply'))
    assert.ok((dryReply.wouldChange ?? []).some((change) => change.to === 'replied'), 'dry-run plans the reply flip')
    const checked = json(ok(run(home, ['mail', 'followup', 'check', '--json'], TOS), 'check real'))
    assert.ok((checked.changed ?? []).some((change) => change.to === 'replied'))

    const replied = json(ok(run(home, ['mail', 'followup', 'ls', '--state', 'replied', '--json'], TOS), 'ls replied'))
    assert.equal(replied.total, 1)
    assert.equal(replied.items[0].state, 'replied')
    assert.ok(replied.items[0].replies.length >= 1)
    const auditActions = (json(ok(run(home, ['audit', '--json'], TOS), 'audit')).entries ?? []).map((entry) => entry.action)
    assert.ok(auditActions.includes('followup.add'))
    assert.ok(auditActions.includes('followup.check'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dismiss, mark-replied, idempotency, usage and not-found exits', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    const emlDir = join(root, 'eml')
    mkdirSync(emlDir, { recursive: true })
    seed(home)
    writeEml(emlDir, 'a.eml', eml({ ...ANCHOR }))
    writeEml(emlDir, 'b.eml', eml({
      from: '李工 <li@beta.cn>', subject: '合同盖章', messageId: '<m5@beta.cn>',
      date: 'Thu, 12 Nov 2026 09:00:00 +0800', body: '合同寄给你。',
    }))
    writeEml(emlDir, 'c.eml', eml({
      from: '赵工 <zhao@gamma.cn>', subject: '验收单', messageId: '<m6@gamma.cn>',
      date: 'Thu, 12 Nov 2026 08:00:00 +0800', body: '验收单稍后发。',
    }))
    importDir(home, emlDir)

    const one = addFollowup(home, '<m1@acme.cn>')
    const duplicate = run(home, ['mail', 'followup', 'add', '--mail', '<m1@acme.cn>', '--counterparty', 'wang@acme.cn', '--json'], TOS)
    assert.equal(duplicate.status, 1)
    assert.equal(stderrJson(duplicate).error.code, 'E_FOLLOWUP_EXISTS')

    const missingRef = run(home, ['mail', 'followup', 'add', '--json'], TOS)
    assert.equal(missingRef.status, 1)
    assert.match(missingRef.stderr, /E_USAGE/)
    const bothRefs = run(home, ['mail', 'followup', 'add', '--mail', '<m1@acme.cn>', '--thread', '<m1@acme.cn>', '--json'], TOS)
    assert.equal(bothRefs.status, 1)
    assert.match(bothRefs.stderr, /E_USAGE/)

    const badReason = run(home, ['mail', 'followup', 'dismiss', one.followup.id, '--reason', 'nope', '--json'], TOS)
    assert.equal(badReason.status, 1)
    assert.match(badReason.stderr, /E_USAGE/)
    const dismissed = json(ok(run(home, ['mail', 'followup', 'dismiss', one.followup.id, '--reason', 'no-follow-up', '--json'], TOS), 'dismiss'))
    assert.equal(dismissed.followup.state, 'dismissed')
    const revive = run(home, ['mail', 'followup', 'mark-replied', one.followup.id, '--json'], TOS)
    assert.equal(revive.status, 1, 'a dismissed row is not silently revived')
    assert.match(revive.stderr, /E_FOLLOWUP_INVALID/)

    const two = addFollowup(home, '<m5@beta.cn>', 'li@beta.cn')
    const marked = ok(run(home, ['mail', 'followup', 'mark-replied', two.followup.id, '--note', '电话确认', '--json'], TOS), 'mark-replied')
    assert.equal(json(marked).followup.state, 'replied')
    const markedAgain = json(ok(run(home, ['mail', 'followup', 'mark-replied', two.followup.id, '--json'], TOS), 'mark-replied idempotent'))
    assert.equal(markedAgain.alreadyReplied, true)

    // --due is resolved at the CLI boundary: a Chinese relative expression is
    // converted to an ISO instant (never stored raw), and an unresolvable one
    // fails closed with the frozen E_DUE_UNRESOLVED code before anything is written.
    const relativeDue = json(ok(run(home, ['mail', 'followup', 'add', '--mail', '<m6@gamma.cn>',
      '--counterparty', 'zhao@gamma.cn', '--due', '明天', '--json'], TOS), 'add with relative due'))
    assert.equal(relativeDue.dueBasis, 'explicit')
    assert.match(relativeDue.followup.dueAt, /^\d{4}-\d{2}-\d{2}T/)
    const badDue = run(home, ['mail', 'followup', 'add', '--mail', '<m6@gamma.cn>', '--counterparty', 'zhao@gamma.cn', '--due', '尽快', '--json'], TOS)
    assert.equal(badDue.status, 1)
    assert.match(badDue.stderr, /E_DUE_UNRESOLVED/)

    const all = json(ok(run(home, ['mail', 'followup', 'ls', '--state', 'all', '--json'], TOS), 'ls all'))
    assert.ok(all.total >= 3)
    const allFlag = json(ok(run(home, ['mail', 'followup', 'ls', '--all', '--json'], TOS), 'ls --all'))
    assert.equal(allFlag.total, all.total, '--all is the shorthand for --state all')
    const actions = (json(ok(run(home, ['audit', '--json'], TOS), 'audit')).entries ?? []).map((entry) => entry.action)
    assert.ok(actions.includes('followup.dismiss'))
    assert.ok(actions.includes('followup.mark-replied'))

    const notFound = run(home, ['mail', 'followup', 'show', 'wr_does_not_exist', '--json'], TOS)
    assert.equal(notFound.status, 1)
    assert.match(notFound.stderr, /E_FOLLOWUP_NOT_FOUND/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('followup keeps the TOS matrix and -h is a pure read', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  try {
    const gated = run(home, ['mail', 'followup', 'ls', '--json'])
    assert.equal(gated.status, 3, 'mail followup is a TOS-gated command')
    assert.match(gated.stderr, /E_TOS_REQUIRED/)
    assert.equal(existsSync(join(home, 'tos.json')), false, 'a blocked command must not record acceptance')

    const helpHome = join(root, 'help-home')
    const help = run(helpHome, ['mail', 'followup', 'add', '--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /usage: advisers mail followup add/)
    assert.equal(existsSync(helpHome), false, '-h/--help must not create HOME')
    assert.deepEqual(readdirSync(root).sort(), ['home'], 'only the gated run created a home')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('human output keeps the local-observation boundary and the state columns', () => {
  const root = makeRoot()
  try {
    const { home } = anchorHome(root)
    const added = ok(run(home, ['mail', 'followup', 'add', '--mail', '<m1@acme.cn>', '--counterparty', 'wang@acme.cn'], TOS), 'human add')
    assert.match(added.stdout, /followup added wr_/)
    assert.match(added.stdout, /state=waiting/)
    assert.match(added.stdout, /本地只读判定/)

    const idMatch = /followup added (wr_[0-9a-f]+)/.exec(added.stdout)
    assert.ok(idMatch, 'the human add line names the followup id')
    const id = idMatch[1]

    const list = ok(run(home, ['mail', 'followup', 'ls'], TOS), 'human ls')
    assert.match(list.stdout, /waiting/)
    assert.match(list.stdout, /wang@acme\.cn/)
    assert.match(list.stdout, /coverage: syncedMailboxes=\d+ sentMailboxSeen=no/)
    assert.match(list.stdout, /sent-mailbox-not-synced/)
    assert.match(list.stdout, /total=1/)

    const check = ok(run(home, ['mail', 'followup', 'check', '--dry-run'], TOS), 'human check')
    assert.match(check.stdout, /followup check \(dry-run\): checked=1/)
    assert.match(check.stdout, /stateChanges=/ )

    const shown = ok(run(home, ['mail', 'followup', 'show', id], TOS), 'human show')
    assert.match(shown.stdout, /commitment=cm_/)
    assert.match(shown.stdout, /anchorAt=/)

    const dismissed = ok(run(home, ['mail', 'followup', 'dismiss', id, '--reason', 'other', '--note', '客户改用电话'], TOS), 'human dismiss')
    assert.match(dismissed.stdout, /dismissed wr_/)
    assert.match(dismissed.stdout, /reason=other/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
