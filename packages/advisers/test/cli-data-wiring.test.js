import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { validateSource } from '../lib/source.js'
import { sendWebhookNotification } from '../lib/notify.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
const localDay = (value = Date.now()) => DAY_FORMAT.format(new Date(value))

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-' + name + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

/** Spawn env: accepted TOS + local workspace packages + no inherited notify adapter. */
function cliEnv(home, extra = {}) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_NOTIFY_CMD: '',
    ...extra,
  })
}

function run(home, args, cwd, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: cliEnv(home, extra) })
}

function runResult(home, args, cwd, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: cliEnv(home, extra) })
}

/** Async sibling of run() so the same process can serve a fake model/webhook. */
function runAsync(home, args, cwd, extra = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: cliEnv(home, extra) }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ status, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

async function withServer(handler, fn) {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => handler(request, response, body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Fake capture model: one verbatim candidate; quote is a substring of every fixture. */
function captureModelHandler(request, response, body) {
  const payload = JSON.parse(body)
  assert.equal(payload.model, 'deepseek-flash')
  const content = JSON.stringify({
    candidates: [{ action: '发报价', debtor: 'user', creditor: '王工', dueAt: null, quote: '周五前把报价发给王工', modal: 'firm', confidence: 0.9, uncertainty: '' }],
  })
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 42 } }))
}

/**
 * Seed one delivered artifact + commitment directly. Text artifacts keep the
 * CLI receipt test fast; docx:true exercises the office verify integration.
 */
async function seedDelivery(home, work, { docx = false } = {}) {
  let artifact = join(work, 'note.txt')
  let validation = 'txt'
  if (docx) {
    const { buildDocx } = await import('../../office/dist/docx.js')
    artifact = join(work, 'quote.docx')
    validation = 'docx'
    writeFileSync(artifact, await buildDocx({ title: '报价确认单', sections: [{ heading: 'A', paragraphs: ['B'] }] }))
  } else {
    writeFileSync(artifact, 'delivered bytes')
  }
  const store = new SqliteStore(join(home, 'state.db'))
  const turn = store.addTurn({ conversationId: 'conv_delivery', role: 'user', content: '周五前把报价发给王工' })
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A' })
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '发报价',
    dueAt: '2026-11-20T18:00:00+08:00',
    capability: 'todo',
    evidence: [{ sessionId: 'conv_delivery', turnId: turn.id, quote: '周五前把报价发给王工' }],
  })
  store.save(ledger.toJSON())
  store.addDelivery({
    matterId: matter.id,
    conversationId: 'conv_delivery',
    files: [artifact],
    tool: 'deliver:confirmation',
    title: '报价确认单',
    validation,
  })
  store.db.close()
  return { artifact, commitmentId: commitment.id }
}

function seedCommitment(home, { source, quote = '旧邮件内容' }) {
  const store = new SqliteStore(join(home, 'state.db'))
  const turn = store.addTurn({ conversationId: 'conv_v1', role: 'user', content: quote })
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '来源兼容' })
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '回复旧邮件',
    dueAt: new Date().toISOString(),
    capability: 'todo',
    evidence: [{ sessionId: 'conv_v1', turnId: turn.id, quote, source }],
  })
  store.save(ledger.toJSON())
  store.db.close()
  return commitment.id
}

test('receipt pack v1.1: CLI generates, verifies offline and detects tampering', async () => {
  const { root, home, work } = setup('cli-receipt')
  try {
    const { artifact } = await seedDelivery(home, work)
    const out = join(work, 'receipt-pack')
    const payload = JSON.parse(run(home, ['deliveries', '--receipt', '--out', out, '--recipient', '王工 <wang@example.com>'], work))
    assert.equal(payload.ok, true)
    assert.equal(payload.format, 'advisers-delivery-receipt-pack')
    assert.equal(payload.version, 1)
    assert.equal(payload.deliveryCount, 1)
    assert.equal(payload.verifyStatus, 'not-recorded')
    assert.equal(payload.anchored, false)
    assert.deepEqual(payload.recipient, { name: '王工', email: 'wang@example.com', note: null })
    assert.equal(payload.fileCount, 4)
    assert.equal(payload.verification.ok, true)
    assert.deepEqual(payload.verification.errors, [])
    assert.ok(payload.verification.warnings.some((warning) => /no verify results were recorded/.test(warning)))
    for (const file of ['manifest.json', 'README.txt', 'SHA256SUMS', 'receipt.docx']) {
      assert.ok(existsSync(join(out, file)), file)
    }
    const manifestText = readFileSync(join(out, 'manifest.json'), 'utf8')
    const readmeText = readFileSync(join(out, 'README.txt'), 'utf8')
    assert.ok(!manifestText.includes(root), 'manifest must not leak absolute paths')
    assert.ok(!readmeText.includes(root), 'README must not leak absolute paths')
    const manifest = JSON.parse(manifestText)
    assert.equal(manifest.format, payload.format)
    assert.equal(manifest.generator.advisersVersion, pkgVersion)
    assert.equal(manifest.generator.command, 'advisers deliveries --receipt')
    assert.equal(manifest.deliveries.length, 1)
    assert.match(manifest.deliveries[0].files[0].path, /^deliveries\//)
    assert.equal(manifest.verifyStatus, 'not-recorded')
    assert.equal(manifest.verify.length, 0)
    assert.equal(manifest.evidence.entryCount, 1)
    assert.equal(manifest.receipt.path, 'receipt.docx')
    const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split(/\s+/))
    assert.equal(sums.length, 4)
    for (const [want, name] of sums) {
      assert.equal(createHash('sha256').update(readFileSync(join(out, ...name.split('/')))).digest('hex'), want, name)
    }
    // The new offline verifier prints JSON and exits 0/1.
    const verified = JSON.parse(run(home, ['evidence', 'verify', out], work))
    assert.equal(verified.ok, true)
    assert.equal(verified.fileCount, 5)
    assert.equal(verified.checksumCount, 4)
    assert.ok(verified.warnings.some((warning) => /not externally anchored/.test(warning)))
    // Tamper: an edit to any covered file is detected, exit code 1.
    writeFileSync(join(out, 'README.txt'), readFileSync(join(out, 'README.txt'), 'utf8') + 'tampered\n')
    const tampered = runResult(home, ['evidence', 'verify', out], work)
    assert.equal(tampered.status, 1)
    const tamperedResult = JSON.parse(tampered.stdout)
    assert.equal(tamperedResult.ok, false)
    assert.ok(tamperedResult.errors.some((error) => /hash mismatch: README\.txt/.test(error)))
    // A non-empty outDir is refused unless --force (old dir moved aside, never deleted).
    assert.equal(runResult(home, ['deliveries', '--receipt', '--out', out], work).status, 1)
    const forced = JSON.parse(run(home, ['deliveries', '--receipt', '--out', out, '--force'], work))
    assert.equal(forced.ok, true)
    assert.ok(forced.replaced, 'replaced old pack directory is reported, not deleted')
    assert.ok(existsSync(forced.replaced))
    // Missing delivery artifacts are skipped with a clear failure, not a fake receipt.
    rmSync(artifact)
    rmSync(out, { recursive: true, force: true })
    if (forced.replaced) rmSync(forced.replaced, { recursive: true, force: true })
    const missing = runResult(home, ['deliveries', '--receipt', '--out', join(work, 'missing-pack')], work)
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /没有仍存在的交付文件/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('receipt pack records office verify results for delivered DOCX artifacts', async () => {
  const { root, home, work } = setup('cli-receipt-verify')
  try {
    await seedDelivery(home, work, { docx: true })
    const out = join(work, 'pack')
    const payload = JSON.parse(run(home, ['deliveries', '--receipt', '--out', out], work))
    assert.equal(payload.ok, true)
    assert.equal(payload.verifyStatus, 'passed')
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.verifyStatus, 'passed')
    assert.equal(manifest.verify.length, 1)
    assert.equal(manifest.verify[0].ok, true)
    assert.match(manifest.verify[0].source, /^advisers verify /)
    assert.ok(Array.isArray(manifest.verify[0].checks))
    const verified = JSON.parse(run(home, ['evidence', 'verify', out], work))
    assert.equal(verified.ok, true)
    assert.equal(verified.manifest.verifyStatus, 'passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('evidence verify is TOS-exempt and needs no ~/.advisers state (offline verifier)', async () => {
  const a = setup('verify-a')
  const b = setup('verify-b')
  try {
    await seedDelivery(a.home, a.work)
    const out = join(a.work, 'pack')
    assert.equal(JSON.parse(run(a.home, ['deliveries', '--receipt', '--out', out], a.work)).ok, true)
    const env = {
      ...process.env,
      ADVISERS_HOME: join(b.root, 'fresh-home'),
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_STORE: 'sqlite',
    }
    delete env.ADVISERS_ACCEPT_TOS
    delete env.ADVISERS_NOTIFY_CMD
    const result = spawnSync(process.execPath, [bin, 'evidence', 'verify', out], { cwd: b.work, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).ok, true)
    assert.equal(existsSync(join(b.root, 'fresh-home')), false, 'offline verify must not create the home directory')
  } finally {
    rmSync(a.root, { recursive: true, force: true })
    rmSync(b.root, { recursive: true, force: true })
  }
})

test('deliveries --receipt caps the default evidence pack at 2000 and supports --ids/--all', () => {
  const { root, home, work } = setup('cli-receipt-limit')
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '大包测试' })
    let firstId
    for (let index = 0; index < 2001; index += 1) {
      const commitment = ledger.addCommitment({
        matterId: matter.id,
        debtor: 'user',
        creditor: '王工',
        action: '任务' + index,
        dueAt: '2026-11-20T18:00:00+08:00',
        capability: 'todo',
        evidence: [{ sessionId: 'conv', turnId: 'turn', quote: 'q' }],
      })
      if (index === 0) firstId = commitment.id
    }
    store.save(ledger.toJSON())
    const artifact = join(work, 'note.txt')
    writeFileSync(artifact, 'delivered bytes')
    store.addDelivery({ matterId: matter.id, conversationId: 'conv', files: [artifact], tool: 'deliver:test', title: 't', validation: 'txt' })
    store.db.close()
    const out = join(work, 'pack')
    const limited = runResult(home, ['deliveries', '--receipt', '--out', out], work)
    assert.equal(limited.status, 1)
    assert.match(limited.stderr, /evidence pack would include 2001 entries/)
    assert.match(limited.stderr, /--ids/)
    assert.match(limited.stderr, /hint: Use --ids/)
    assert.equal(existsSync(out), false, 'no partial pack is left behind')
    const narrowed = JSON.parse(run(home, ['deliveries', '--receipt', '--out', out, '--ids', firstId], work))
    assert.equal(narrowed.ok, true)
    assert.equal(narrowed.evidence.entryCount, 1)
    const all = JSON.parse(run(home, ['deliveries', '--receipt', '--out', join(work, 'pack-all'), '--all'], work))
    assert.equal(all.ok, true)
    assert.equal(all.evidence.entryCount, 2001)
    assert.equal(all.verifyStatus, 'not-recorded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('today --calendar expands RRULE locally and today --json exposes the whole view', () => {
  const { root, home, work } = setup('cli-today')
  try {
    const today = localDay()
    const compactToday = today.replaceAll('-', '')
    const twoWeeksAgo = new Date(Date.parse(today + 'T00:00:00+08:00') - 14 * 86400_000)
    const startDay = DAY_FORMAT.format(twoWeeksAgo)
    const startCompact = startDay.replaceAll('-', '')
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(startDay + 'T12:00:00+08:00').getUTCDay()]
    const yesterdayCompact = DAY_FORMAT.format(new Date(Date.parse(today + 'T00:00:00+08:00') - 86400_000)).replaceAll('-', '')
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:weekly-1',
      'SUMMARY:客户周会',
      'DTSTART;TZID=Asia/Shanghai:' + startCompact + 'T100000',
      'DTEND;TZID=Asia/Shanghai:' + startCompact + 'T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=' + weekday,
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:allday-1',
      'SUMMARY:公司假日',
      'DTSTART;VALUE=DATE:' + compactToday,
      'DTEND;VALUE=DATE:' + compactToday,
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:yesterday-1',
      'SUMMARY:昨天的事',
      'DTSTART;TZID=Asia/Shanghai:' + yesterdayCompact + 'T090000',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\n')
    writeFileSync(join(work, 'cal.ics'), ics)
    assert.match(run(home, ['calendar', 'import', '--ics', 'cal.ics'], work), /3 events/)
    const human = run(home, ['today', '--calendar'], work)
    assert.match(human, /日历（本地只读，\d{4}-\d{2}-\d{2}）：/)
    assert.match(human, /全天\s+公司假日/)
    assert.match(human, /10:00\s+客户周会（循环）/)
    assert.doesNotMatch(human, /昨天的事/)
    // The plain one-screen view is unchanged and writes no JSON state file.
    const plain = run(home, ['today'], work)
    assert.doesNotMatch(plain, /客户周会/)
    assert.equal(existsSync(join(home, 'state.json')), false)
    const json = JSON.parse(run(home, ['today', '--json', '--calendar'], work))
    assert.equal(json.localDay, today)
    assert.deepEqual(Object.keys(json.counts).sort(), ['noDue', 'overdue', 'today', 'waiting', 'week'])
    assert.equal(json.counts.today, 0)
    const weekly = json.calendar.find((event) => event.uid === 'weekly-1')
    assert.equal(weekly.recurring, true)
    assert.equal(weekly.startsAt, today + 'T10:00:00+08:00')
    assert.equal(weekly.rrule, 'FREQ=WEEKLY;BYDAY=' + weekday)
    const allDay = json.calendar.find((event) => event.uid === 'allday-1')
    assert.equal(allDay.allDay, true)
    assert.equal(allDay.startsAt, today)
    assert.equal(allDay.recurring, false)
    assert.equal(json.calendar.some((event) => event.uid === 'yesterday-1'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('capture --json writes source v2 provenance (conversation/mail/transcript) and memory candidates --json', async () => {
  const { root, home, work } = setup('cli-source-v2')
  try {
    await withServer(captureModelHandler, async (port) => {
      const modelEnv = {
        ADVISERS_NO_MODEL: '0',
        ADVISERS_API_KEY: 'test-key',
        ADVISERS_BASE_URL: 'http://127.0.0.1:' + port,
        ADVISERS_MODEL: 'deepseek-flash',
        ADVISERS_SAFETY_CLOUD: '0',
      }
      // 1) Bare capture -> type conversation.
      const plain = await runAsync(home, ['capture', '--json', '周五前把报价发给王工'], work, modelEnv)
      assert.equal(plain.status, 0, plain.stderr)
      const plainJson = JSON.parse(plain.stdout)
      assert.equal(plainJson.ok, true)
      assert.equal(plainJson.count, 1)
      assert.equal(plainJson.candidates.length, 1)
      const conversationSource = plainJson.candidates[0].evidence[0].source
      assert.equal(conversationSource.sourceVersion, 2)
      assert.equal(conversationSource.type, 'conversation')
      assert.equal(conversationSource.quote, '周五前把报价发给王工')
      assert.match(conversationSource.ref, /#.+$/)
      assert.ok(conversationSource.capturedAt)
      assert.equal(validateSource(conversationSource).ok, true)
      // 2) Mail import -> mail source with RFC822 provenance.
      const eml = join(work, 'q4.eml')
      writeFileSync(eml, [
        'From: 王工 <wang@example.com>',
        'To: me@example.com',
        'Subject: Q4 报价',
        'Date: Fri, 13 Nov 2026 10:00:00 +0800',
        'Message-ID: <q4-1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '周五前把报价发给王工',
        '',
      ].join('\n'))
      const mail = await runAsync(home, ['capture', '--from-mail', eml, '--json'], work, modelEnv)
      assert.equal(mail.status, 0, mail.stderr)
      const mailJson = JSON.parse(mail.stdout)
      assert.equal(mailJson.ok, true)
      assert.equal(mailJson.count, 1)
      const mailSource = mailJson.candidates[0].evidence[0].source
      assert.equal(mailSource.sourceVersion, 2)
      assert.equal(mailSource.type, 'mail')
      assert.equal(mailSource.messageId, 'q4-1@example.com')
      assert.equal(mailSource.subject, 'Q4 报价')
      assert.equal(mailSource.from, '王工 <wang@example.com>')
      assert.equal(validateSource(mailSource).ok, true)
      // 3) Transcript import -> transcript source with basename + speaker.
      const vtt = join(work, 'meeting.vtt')
      writeFileSync(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v 王工>周五前把报价发给王工\n')
      const transcript = await runAsync(home, ['capture', '--from-transcript', vtt, '--json'], work, modelEnv)
      assert.equal(transcript.status, 0, transcript.stderr)
      const transcriptJson = JSON.parse(transcript.stdout)
      assert.equal(transcriptJson.count, 1)
      const transcriptSource = transcriptJson.candidates[0].evidence[0].source
      assert.equal(transcriptSource.sourceVersion, 2)
      assert.equal(transcriptSource.type, 'transcript')
      assert.equal(transcriptSource.file, 'meeting.vtt')
      assert.equal(transcriptSource.speaker, '王工')
      assert.equal(validateSource(transcriptSource).ok, true)
    })
    const candidates = JSON.parse(run(home, ['memory', 'candidates', '--json'], work))
    assert.ok(Array.isArray(candidates))
    assert.equal(candidates.length, 3)
    for (const candidate of candidates) {
      assert.equal(candidate.status, 'pending')
      assert.equal(candidate.evidence[0].source.sourceVersion, 2)
    }
    // 4) Read side: a stored v1 source renders as v2 without rewriting the row.
    const commitmentId = seedCommitment(home, { source: { type: 'email', subject: '旧邮件', messageId: '<old@example.com>' } })
    const shown = JSON.parse(run(home, ['evidence', 'show', commitmentId, '--json'], work))
    assert.equal(shown.commitment.evidence[0].source.type, 'mail')
    assert.equal(shown.commitment.evidence[0].source.sourceVersion, 2)
    const todayJson = JSON.parse(run(home, ['today', '--json', '--sources'], work))
    const row = todayJson.sources.find((source) => source.commitmentId === commitmentId)
    assert.equal(row.type, 'mail')
    assert.equal(row.quote, '旧邮件内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reminder offsets round-trip, scheduler dry-run/status, and webhook opt-in', async () => {
  const { root, home, work } = setup('cli-remind-wiring')
  try {
    const due = new Date(Date.now() + 86400_000).toISOString()
    const added = run(home, ['commit', 'add', '交周报', '--quote', '明天下班前交', '--due', due, '--remind-offsets', '-1d,-2h,+0d09:00'], work)
    assert.match(added, /reminder-offsets: \["-1d","-2h","\+0d09:00"\]/)
    const id = added.split(/\s+/)[0]
    const rows = JSON.parse(run(home, ['commit', 'ls', '--json'], work))
    assert.deepEqual(rows.find((row) => row.id === id).reminderOffsets, ['-1d', '-2h', '+0d09:00'])
    const reminders = JSON.parse(run(home, ['remind', '--json'], work)).reminders
    const reminder = reminders.find((item) => item.commitmentId === id)
    assert.deepEqual(reminder.reminderOffsets, ['-1d', '-2h', '+0d09:00'])
    // Editing goes through ledger.updateCommitment: offsets round-trip ...
    assert.match(run(home, ['commit', 'edit', id, '--remind-offsets', '+2h'], work), /reminder-offsets: \["\+2h"\]/)
    assert.deepEqual(JSON.parse(run(home, ['commit', 'ls', '--json'], work)).find((row) => row.id === id).reminderOffsets, ['+2h'])
    // ... and --no-remind removes the optional field entirely (old shape restored).
    run(home, ['commit', 'edit', id, '--no-remind'], work)
    assert.equal('reminderOffsets' in JSON.parse(run(home, ['commit', 'ls', '--json'], work)).find((row) => row.id === id), false)
    assert.equal('reminderOffsets' in JSON.parse(run(home, ['remind', '--json'], work)).reminders.find((item) => item.commitmentId === id), false)
    // Invalid offsets fail closed instead of writing a malformed ledger row.
    const bad = runResult(home, ['commit', 'edit', id, '--remind-offsets', '1d'], work)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /invalid reminder offset/)
    // Scheduler: default is a dry-run plan (no system command is executed).
    const install = run(home, ['remind', 'install'], work)
    assert.match(install, /scheduler scripts written:/)
    assert.match(install, /dry-run/)
    assert.match(install, /schedule: /)
    assert.ok(/crontab -|schtasks/.test(install), 'dry-run prints the OS registration command')
    assert.ok(existsSync(join(home, 'scheduler', 'remind.sh')))
    const statusBefore = run(home, ['remind', 'status'], work)
    assert.match(statusBefore, /scheduler scripts:/)
    assert.match(statusBefore, /last run: none recorded/)
    // A real --deliver run records scheduler/status.json.
    const delivered = run(home, ['remind', '--deliver'], work)
    assert.match(delivered, /交周报/)
    assert.ok(existsSync(join(home, 'reminders.log')))
    const statusFile = JSON.parse(readFileSync(join(home, 'scheduler', 'status.json'), 'utf8'))
    assert.equal(statusFile.lastResult, 'ok')
    assert.equal(statusFile.lastCount, 1)
    assert.equal(statusFile.lastChannel, 'log')
    assert.match(statusFile.lastRun, /^\d{4}-\d{2}-\d{2}T/)
    const statusAfter = run(home, ['remind', 'status'], work)
    assert.match(statusAfter, /last run: /)
    assert.match(statusAfter, /result=ok/)
    assert.match(statusAfter, /channel=log/)
    // Webhook unconfigured is a structured no-op (local log stays the channel).
    const savedWebhook = process.env.ADVISERS_NOTIFY_WEBHOOK
    delete process.env.ADVISERS_NOTIFY_WEBHOOK
    try {
      const unconfigured = await sendWebhookNotification([{ level: 'L2', dueAt: due }])
      assert.deepEqual(unconfigured, { sent: false, channel: 'webhook', configured: false, reason: 'not-configured' })
    } finally {
      if (savedWebhook !== undefined) process.env.ADVISERS_NOTIFY_WEBHOOK = savedWebhook
    }
    // Webhook configured: remind --deliver --notify POSTs the minimal payload.
    let received
    await withServer((request, response, body) => {
      received = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    }, async (port) => {
      const notified = await runAsync(home, ['remind', '--deliver', '--notify'], work, { ADVISERS_NOTIFY_WEBHOOK: 'http://127.0.0.1:' + port + '/hook' })
      assert.equal(notified.status, 0, notified.stderr)
      assert.match(notified.stdout, /通知通道：/)
    })
    assert.ok(received, 'webhook payload was delivered')
    assert.equal(received.schema, 'advisers.notify.webhook.v1')
    assert.equal(received.count, 1)
    assert.deepEqual(received.levels, { L1: 1, L2: 0, L3: 0 })
    assert.deepEqual(received.dates, [localDay(Date.parse(due))])
    assert.ok(!JSON.stringify(received).includes('交周报'), 'webhook payload carries no titles')
    const statusWebhook = JSON.parse(readFileSync(join(home, 'scheduler', 'status.json'), 'utf8'))
    assert.match(statusWebhook.lastChannel, /webhook/)
    assert.match(run(home, ['remind', 'uninstall'], work), /scheduler scripts removed/)
    assert.equal(existsSync(join(home, 'scheduler')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify --json keeps the office verify checks/ok structure', async () => {
  const { root, home, work } = setup('cli-verify-json')
  try {
    const { buildDocx } = await import('../../office/dist/docx.js')
    const output = join(work, 'x.docx')
    writeFileSync(output, await buildDocx({ title: 'X', sections: [{ heading: 'A', paragraphs: ['B'] }] }))
    // Flags may come before or after the positional file; --content wraps both views.
    const result = JSON.parse(run(home, ['verify', '--json', output, '--content'], work))
    assert.equal(result.structure.ok, true)
    assert.ok(Array.isArray(result.structure.checks))
    assert.ok(result.structure.checks.length > 0)
    for (const check of result.structure.checks) {
      assert.equal(typeof check.id, 'string')
      assert.equal(typeof check.ok, 'boolean')
    }
    assert.equal(typeof result.content.ok, 'boolean')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
