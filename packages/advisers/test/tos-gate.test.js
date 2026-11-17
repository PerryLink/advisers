/**
 * TOS consent gate (docs/TOS.md §2) — end-to-end CLI behaviour plus pure
 * decision/store unit tests.
 *
 * Scope: first-run gate (exit 3 + E_TOS_REQUIRED on non-TTY), --accept-tos /
 * ADVISERS_ACCEPT_TOS channels, the 0600 acceptance record, audit rows
 * (tos.accept / tos.block / tos.reaccept / tos.revoke), revoke, version changes,
 * the L2 modification re-confirmation and the TTY-only decision helpers (tested
 * as pure functions so no PTY is needed).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  acceptanceStatus,
  currentTos,
  decidePrompt,
  isExemptCommand,
  modificationNotice,
  readAcceptance,
  readSourceFingerprint,
  resolveConsent,
  revokeAcceptance,
  shouldNoticeSourceModified,
  sourceCheckoutFingerprint,
  sourceModifiedNotice,
  summaryLines,
  writeAcceptance,
  writeSourceFingerprint,
} from '../lib/tos/index.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const isWindows = process.platform === 'win32'

function baseEnv(home) {
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' }
  // The suite must exercise the real gate, never a value inherited from the shell.
  delete env.ADVISERS_ACCEPT_TOS
  delete env.ADVISERS_TOS_VERSION
  delete env.ADVISERS_YES
  return env
}

function sanitizeStderr(text) {
  // Node 22 prints an ExperimentalWarning for node:sqlite before user output;
  // the consent gate assertions are about the user-facing stderr only.
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !line.includes('ExperimentalWarning') && !line.includes('trace-warnings'))
    .join('\n')
    .replace(/^\n+/, '')
}

function run(home, args, extra = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], { env: { ...baseEnv(home), ...extra }, encoding: 'utf8' })
  result.stderr = sanitizeStderr(result.stderr)
  return result
}

function runOk(home, args, extra = {}) {
  const result = run(home, args, extra)
  assert.equal(result.status, 0, `advisers ${args.join(' ')} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  return result
}

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), `advisers-tos-${name}-`))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

function readTosRecord(home) {
  return JSON.parse(readFileSync(join(home, 'tos.json'), 'utf8'))
}

function auditRows(home) {
  const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
  try {
    return db.prepare('SELECT seq, action, allowed, reason FROM audit ORDER BY seq').all()
  } finally {
    db.close()
  }
}

function auditFor(home, action) {
  return auditRows(home).filter((row) => row.action === action)
}

function assertFileMode0600(file) {
  if (isWindows) return
  assert.equal(statSync(file).mode & 0o777, 0o600, `${file} must be 0600`)
}

test('TOS-T1: fresh home blocks a non-TTY command with exit 3, clean stdout and an audited tos.block', () => {
  const { root, home } = setup('fresh-block')
  try {
    const result = run(home, ['commit', 'add', '发报价', '--quote', 'q'])
    assert.equal(result.status, 3)
    assert.equal(result.stdout, '')
    const lines = result.stderr.trim().split(/\r?\n/)
    assert.equal(lines.length, 1, 'non-TTY block must be a single stderr line')
    assert.match(lines[0], /E_TOS_REQUIRED/)
    assert.match(lines[0], /--accept-tos/)
    assert.match(lines[0], /ADVISERS_ACCEPT_TOS=1/)
    assert.equal(existsSync(join(home, 'tos.json')), false, 'a block must not write an acceptance record')

    const blocks = auditFor(home, 'tos.block')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].allowed, 0)
    const info = currentTos()
    assert.match(blocks[0].reason, new RegExp(`version=${info.version.replace(/\./g, '\\.')}`))
    assert.match(blocks[0].reason, new RegExp(`sha256=${info.sha256}`))
    assert.match(blocks[0].reason, /channel=none/)
    assert.doesNotMatch(blocks[0].reason, /Advisers · 使用条款摘要|PolyForm Noncommercial 1\.0\.0，仅限个人非商业用途；商业使用需另行书面授权。文档/)

    // `tos status` stays usable on a blocked home and reports the block audit.
    const status = JSON.parse(runOk(home, ['tos', 'status', '--json']).stdout)
    assert.equal(status.accepted, false)
    assert.equal(status.reason, 'missing')
    assert.equal(status.audit.available, true)
    assert.equal(status.audit.verified, true)
    assert.equal(status.audit.counts.block, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T2: ADVISERS_ACCEPT_TOS=1 records channel=env, nonInteractive=1 and a single tos.accept audit row', () => {
  const { root, home, work } = setup('env-accept')
  try {
    const accepted = runOk(home, ['commit', 'add', '发报价', '--quote', 'q'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.match(accepted.stdout, /发报价/)

    const info = currentTos()
    const record = readTosRecord(home)
    assert.deepEqual(Object.keys(record).sort(), ['acceptedAt', 'channel', 'nonInteractive', 'sha256', 'version'])
    assert.equal(record.version, info.version)
    assert.equal(record.sha256, info.sha256)
    assert.equal(record.channel, 'env')
    assert.equal(record.nonInteractive, true)
    assert.ok(!Number.isNaN(Date.parse(record.acceptedAt)))
    assertFileMode0600(join(home, 'tos.json'))
    assert.ok(statSync(join(home, 'tos.json')).size < 2048, 'the record must not embed the terms text')
    assert.doesNotMatch(readFileSync(join(home, 'tos.json'), 'utf8'), /## |使用条款摘要|PolyForm/)

    const accepts = auditFor(home, 'tos.accept')
    assert.equal(accepts.length, 1)
    assert.match(accepts[0].reason, new RegExp(`version=${info.version.replace(/\./g, '\\.')}`))
    assert.match(accepts[0].reason, new RegExp(`sha256=${info.sha256}`))
    assert.match(accepts[0].reason, /channel=env/)
    assert.match(accepts[0].reason, /nonInteractive=1/)

    const audit = runOk(home, ['audit'])
    assert.match(audit.stdout, /audit: verified/)
    assert.match(audit.stdout, /tos\.accept\s+allow/)
    assert.doesNotMatch(audit.stdout, /使用条款摘要/, 'the audit reason must not contain the terms body')

    // A second command is not re-prompted and does not add another accept row.
    const second = runOk(home, ['commit', 'ls'])
    assert.equal(second.stderr, '')
    assert.doesNotMatch(second.stdout, /tos|使用条款/i)
    assert.equal(auditFor(home, 'tos.accept').length, 1)

    // Machine-readable command output stays pure JSON after acceptance.
    const json = JSON.parse(runOk(home, ['status', '--json']).stdout)
    assert.ok(json.version)
    assert.equal(json.tos, undefined, 'status --json shape is unchanged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T3: --accept-tos (global flag, before or after the command) records channel=flag', () => {
  const { root, home } = setup('flag-accept')
  try {
    const before = runOk(home, ['--accept-tos', 'commit', 'add', '甲', '--quote', 'q'])
    assert.match(before.stdout, /甲/)
    let record = readTosRecord(home)
    assert.equal(record.channel, 'flag')
    assert.equal(record.nonInteractive, true)
    assert.match(auditFor(home, 'tos.accept')[0].reason, /channel=flag/)

    const other = setup('flag-accept-2')
    try {
      const after = runOk(other.home, ['commit', 'add', '乙', '--quote', 'q', '--accept-tos'])
      assert.match(after.stdout, /乙/)
      assert.equal(readTosRecord(other.home).channel, 'flag')
    } finally {
      rmSync(other.root, { recursive: true, force: true })
    }

    const mismatched = setup('flag-mismatch')
    try {
      const result = run(mismatched.home, ['--accept-tos=2099.1.1', 'commit', 'ls'])
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /does not match the current TOS version 2026\.11\.2/)
      assert.equal(existsSync(join(mismatched.home, 'tos.json')), false)
    } finally {
      rmSync(mismatched.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T4: help/--version/status/doctor/init/tos show|status|accept|revoke are not blocked on a fresh home', () => {
  const { root, home } = setup('exempt')
  try {
    assert.match(runOk(home, ['help']).stdout, /advisers tos show\|status/)
    assert.match(runOk(home, ['--version']).stdout.trim(), /^\d+\.\d+\.\d+/)
    assert.match(runOk(home, ['init']).stdout, /soul/)
    assert.match(runOk(home, ['status']).stdout, /version/)
    assert.match(runOk(home, ['doctor']).stdout, /PASS  sqlite/)
    const show = runOk(home, ['tos', 'show'])
    assert.match(show.stdout, /Advisers 使用条款 v/)
    assert.match(show.stdout, /文本 SHA-256：/)
    const status = runOk(home, ['tos', 'status'])
    assert.match(status.stdout, /accepted  no/)
    const noSub = runOk(home, ['tos'])
    assert.match(noSub.stdout, /usage: advisers tos/)

    // No acceptance record may be created by exempt commands.
    assert.equal(existsSync(join(home, 'tos.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T5: tos revoke marks the record revoked, adds tos.revoke and re-blocks gated commands', () => {
  const { root, home } = setup('revoke')
  try {
    runOk(home, ['commit', 'add', '发报价', '--quote', 'q'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(readTosRecord(home).revokedAt, undefined)

    const noYes = run(home, ['tos', 'revoke'])
    assert.equal(noYes.status, 1)
    assert.match(noYes.stderr, /--yes/)
    assert.equal(readTosRecord(home).revokedAt, undefined)

    const revoked = runOk(home, ['tos', 'revoke', '--yes'])
    assert.match(revoked.stdout, /已撤回/)
    const record = readTosRecord(home)
    assert.ok(record.revokedAt)
    assert.ok(!Number.isNaN(Date.parse(record.revokedAt)))
    const revokes = auditFor(home, 'tos.revoke')
    assert.equal(revokes.length, 1)
    assert.match(revokes[0].reason, /channel=command/)
    assert.match(revokes[0].reason, /scope=app/)

    const blocked = run(home, ['commit', 'ls'])
    assert.equal(blocked.status, 3)
    assert.equal(blocked.stdout, '')
    assert.match(blocked.stderr, /E_TOS_REQUIRED/)
    const status = JSON.parse(runOk(home, ['tos', 'status', '--json']).stdout)
    assert.equal(status.accepted, false)
    assert.equal(status.reason, 'revoked')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T6: a version change re-requires acceptance; accepting the new version overwrites the record', () => {
  const { root, home } = setup('version-change')
  try {
    runOk(home, ['commit', 'ls'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(readTosRecord(home).version, '2026.11.2')

    const blocked = run(home, ['commit', 'ls'], { ADVISERS_TOS_VERSION: '2099.1.1' })
    assert.equal(blocked.status, 3)
    assert.equal(blocked.stdout, '')
    assert.match(blocked.stderr, /2099\.1\.1/)
    assert.match(blocked.stderr, /E_TOS_REQUIRED/)

    runOk(home, ['commit', 'ls'], { ADVISERS_TOS_VERSION: '2099.1.1', ADVISERS_ACCEPT_TOS: '1' })
    const record = readTosRecord(home)
    assert.equal(record.version, '2099.1.1')
    assert.equal(record.channel, 'env')
    const accepts = auditFor(home, 'tos.accept')
    assert.equal(accepts.length, 2)
    assert.match(accepts[1].reason, /version=2099\.1\.1/)

    const status = JSON.parse(runOk(home, ['tos', 'status', '--json'], { ADVISERS_TOS_VERSION: '2099.1.1' }).stdout)
    assert.equal(status.accepted, true)
    assert.equal(status.acceptance.version, '2099.1.1')
    const stale = JSON.parse(runOk(home, ['tos', 'status', '--json']).stdout)
    assert.equal(stale.accepted, false)
    assert.equal(stale.reason, 'version-changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T7: tos accept never silently accepts in a non-TTY without --accept-tos/env', () => {
  const { root, home } = setup('accept-nontty')
  try {
    const blocked = run(home, ['tos', 'accept'])
    assert.equal(blocked.status, 3)
    assert.equal(blocked.stdout, '')
    assert.match(blocked.stderr, /E_TOS_REQUIRED/)
    assert.equal(existsSync(join(home, 'tos.json')), false)

    const accepted = runOk(home, ['tos', 'accept'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.match(accepted.stdout, /已接受使用条款/)
    assert.equal(readTosRecord(home).channel, 'env')
    assert.equal(auditFor(home, 'tos.accept').length, 1)

    const again = runOk(home, ['tos', 'accept'])
    assert.match(again.stdout, /已接受使用条款/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T8: modification surfaces need a fresh confirmation (tos.reaccept) and --yes does not substitute', () => {
  const { root, home, work } = setup('reaccept')
  try {
    runOk(home, ['commit', 'ls'], { ADVISERS_ACCEPT_TOS: '1' })
    const soulFile = join(work, 'soul.md')
    writeFileSync(soulFile, '你是我的幕僚。\n')

    const blockedSoul = run(home, ['soul', 'set', soulFile], { ADVISERS_YES: '1' })
    assert.equal(blockedSoul.status, 3)
    assert.equal(blockedSoul.stdout, '')
    assert.match(blockedSoul.stderr, /E_TOS_REQUIRED/)
    assert.match(blockedSoul.stderr, /--yes 不能代替/)
    assert.equal(existsSync(join(home, 'soul.md')), false, 'the persona must not be written before confirmation')

    runOk(home, ['soul', 'set', soulFile], { ADVISERS_ACCEPT_TOS: '1' })
    assert.match(readFileSync(join(home, 'soul.md'), 'utf8'), /你是我的幕僚/)
    const soulReaccept = auditFor(home, 'tos.reaccept').filter((row) => /scope=config/.test(row.reason))
    assert.equal(soulReaccept.length, 1)
    assert.match(soulReaccept[0].reason, /action=soul set/)
    assert.match(soulReaccept[0].reason, /channel=env/)

    const specFile = join(work, 'routine.json')
    writeFileSync(specFile, JSON.stringify({ name: '周报流程', description: '', steps: [{ kind: 'file', path: 'out/week.docx' }] }))
    const blockedRoutine = run(home, ['routine', 'add', specFile])
    assert.equal(blockedRoutine.status, 3)
    assert.match(blockedRoutine.stderr, /E_TOS_REQUIRED/)
    runOk(home, ['routine', 'add', specFile], { ADVISERS_ACCEPT_TOS: '1' })
    const routineReaccept = auditFor(home, 'tos.reaccept').filter((row) => /scope=routine/.test(row.reason))
    assert.equal(routineReaccept.length, 1)

    const exportFile = join(work, 'export.json')
    runOk(home, ['export', '--all', '--out', exportFile], { ADVISERS_ACCEPT_TOS: '1' })
    const blockedImport = run(home, ['import', exportFile, '--replace'])
    assert.equal(blockedImport.status, 3)
    assert.match(blockedImport.stderr, /E_TOS_REQUIRED/)
    runOk(home, ['import', exportFile, '--replace'], { ADVISERS_ACCEPT_TOS: '1' })
    const importReaccept = auditFor(home, 'tos.reaccept').filter((row) => /scope=import/.test(row.reason))
    assert.equal(importReaccept.length, 1)
    assert.match(importReaccept[0].reason, /action=import --replace/)

    const verified = runOk(home, ['audit'])
    assert.match(verified.stdout, /audit: verified/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T9: acceptance JSON store is 0600/atomic and invalid or mismatched records fail closed', () => {
  const { root, home } = setup('store')
  try {
    const info = currentTos()
    assert.deepEqual(acceptanceStatus({ home, version: info.version, sha256: info.sha256 }), { accepted: false, reason: 'missing', record: null })
    assert.equal(readAcceptance(home), null)

    const written = writeAcceptance(home, {
      version: info.version,
      sha256: info.sha256,
      acceptedAt: '2026-11-17T00:00:00.000Z',
      channel: 'interactive',
      nonInteractive: false,
    })
    assert.equal(written.channel, 'interactive')
    assertFileMode0600(join(home, 'tos.json'))
    assert.deepEqual(acceptanceStatus({ home, version: info.version, sha256: info.sha256 }).accepted, true)
    assert.equal(acceptanceStatus({ home, version: '2099.1.1', sha256: info.sha256 }).reason, 'version-changed')
    assert.equal(acceptanceStatus({ home, version: info.version, sha256: 'f'.repeat(64) }).reason, 'text-changed')

    revokeAcceptance(home, { revokedAt: '2026-11-17T01:00:00.000Z' })
    assert.equal(acceptanceStatus({ home, version: info.version, sha256: info.sha256 }).reason, 'revoked')
    assert.equal(readTosRecord(home).revokedAt, '2026-11-17T01:00:00.000Z')

    writeFileSync(join(home, 'tos.json'), '{ not json')
    assert.equal(readAcceptance(home), null)
    assert.equal(acceptanceStatus({ home, version: info.version, sha256: info.sha256 }).reason, 'missing')
    writeFileSync(join(home, 'tos.json'), JSON.stringify({ version: info.version }))
    assert.equal(readAcceptance(home), null)
    assert.throws(() => writeAcceptance(home, { version: 'x' }), /invalid TOS acceptance record/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T10: TTY decision helpers require the explicit 同意 word and the summary stays 8–12 lines', () => {
  assert.equal(decidePrompt('同意').accepted, true)
  assert.equal(decidePrompt('  同意  ').accepted, true)
  assert.equal(decidePrompt('y').accepted, true)
  assert.equal(decidePrompt('YES').accepted, true)
  assert.equal(decidePrompt('').accepted, false)
  assert.equal(decidePrompt('\n').reason, 'empty')
  assert.equal(decidePrompt('n').accepted, false)
  assert.equal(decidePrompt('no').accepted, false)
  assert.equal(decidePrompt('sure').accepted, false)

  const info = currentTos()
  const lines = summaryLines({ version: info.version })
  assert.ok(lines.length >= 8 && lines.length <= 12, `summary must be 8–12 lines, got ${lines.length}`)
  const summary = lines.join('\n')
  assert.match(summary, /责任限制/)
  assert.match(summary, /15\.2/)
  assert.match(summary, /advisers tos show/)
  assert.match(summary, /advisers tos revoke/)
  assert.match(summary, /https:\/\/github\.com\/PerryLink\/advisers/)
  assert.match(summary, new RegExp(info.version.replace(/\./g, '\\.')))
  assert.doesNotMatch(summary, /按 Enter 接受/, 'Enter must not be presented as acceptance')

  for (const scope of ['config', 'routine', 'import']) {
    const notice = modificationNotice({ scope, action: 'x' })
    assert.ok(notice.length >= 1 && notice.length <= 5, `${scope} notice must be <=5 lines`)
    assert.ok(notice.join('\n').length > 0)
  }

  assert.equal(isExemptCommand('help'), true)
  assert.equal(isExemptCommand('--version'), true)
  assert.equal(isExemptCommand('status'), true)
  assert.equal(isExemptCommand('doctor'), true)
  assert.equal(isExemptCommand('init'), true)
  assert.equal(isExemptCommand('tos'), true)
  assert.equal(isExemptCommand('commit'), false)
  assert.equal(isExemptCommand(undefined, { isTTY: false }), true)
  assert.equal(isExemptCommand(undefined, { isTTY: true }), false)

  // TOS §2.5: the env var never takes effect in a TTY; the explicit flag does.
  assert.equal(resolveConsent({ env: '1', version: info.version, isTTY: true }), null)
  assert.deepEqual(resolveConsent({ env: '1', version: info.version, isTTY: false }), { ok: true, channel: 'env', nonInteractive: true })
  assert.deepEqual(resolveConsent({ flag: true, env: '0', version: info.version, isTTY: true }), { ok: true, channel: 'flag', nonInteractive: true })
  assert.equal(resolveConsent({ env: '0', version: info.version, isTTY: false }), null)
  assert.equal(resolveConsent({ env: '', version: info.version, isTTY: false }), null)
  assert.match(resolveConsent({ env: 'maybe', version: info.version, isTTY: false }).error, /ADVISERS_ACCEPT_TOS/)
  assert.deepEqual(resolveConsent({ env: info.version, version: info.version, isTTY: false }), { ok: true, channel: 'env', nonInteractive: true })
  assert.equal(resolveConsent({ flag: '2099.1.1', version: info.version, isTTY: false }).ok, false)
})

test('TOS-T11: JSON store mode still gates commands (record works, audit reports unavailable)', () => {
  const { root, home } = setup('json-store')
  try {
    const blocked = run(home, ['commit', 'ls'], { ADVISERS_STORE: 'json' })
    assert.equal(blocked.status, 3)
    assert.equal(blocked.stdout, '')
    assert.match(blocked.stderr, /E_TOS_REQUIRED/)
    assert.equal(existsSync(join(home, 'tos.json')), false)

    const passed = run(home, ['commit', 'ls'], { ADVISERS_STORE: 'json', ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(passed.status, 0)
    assert.equal(passed.stdout.trim(), '没有承诺')
    assert.equal(readTosRecord(home).channel, 'env')
    assert.equal(existsSync(join(home, 'state.db')), false)

    const status = JSON.parse(runOk(home, ['tos', 'status', '--json'], { ADVISERS_STORE: 'json' }).stdout)
    assert.equal(status.accepted, true)
    assert.equal(status.audit.available, false)
    assert.match(status.audit.note, /json store/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TOS-T12: source-modified dev notice is TTY-only, non-blocking and once per dirty fingerprint', () => {
  const { root, home } = setup('dev-source')
  try {
    // CLI runs started by the test suite are non-TTY: no notice, no marker file.
    const out = runOk(home, ['commit', 'ls'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.doesNotMatch(out.stderr, /开发者模式/)
    assert.equal(existsSync(join(home, 'source-reviewed.json')), false)

    const fingerprint = sourceCheckoutFingerprint()
    assert.ok(fingerprint === null || /^([0-9a-f]{7}|nogit)(\+dirty)?$/.test(fingerprint), String(fingerprint))
    assert.equal(shouldNoticeSourceModified({ home, fingerprint: 'abc1234' }), false)
    assert.equal(shouldNoticeSourceModified({ home, fingerprint: 'abc1234+dirty' }), true)
    writeSourceFingerprint(home, 'abc1234+dirty')
    assert.equal(readSourceFingerprint(home), 'abc1234+dirty')
    assert.equal(shouldNoticeSourceModified({ home, fingerprint: 'abc1234+dirty' }), false)
    assert.equal(shouldNoticeSourceModified({ home, fingerprint: 'def5678+dirty' }), true)

    const notice = sourceModifiedNotice({ fingerprint: 'abc1234+dirty' })
    assert.ok(notice.length >= 1 && notice.length <= 3, 'the dev notice must stay short')
    const text = notice.join('\n')
    assert.match(text, /源码修改版/)
    assert.match(text, /abc1234\+dirty/)
    assert.match(text, /PolyForm Noncommercial 1\.0\.0/)
    assert.match(text, /policy/)
    assert.match(text, /不阻塞/)
    if (!isWindows) assert.equal(statSync(join(home, 'source-reviewed.json')).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
