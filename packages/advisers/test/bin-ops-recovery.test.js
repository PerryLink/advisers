/**
 * 0.3.0 Wave 2 (P0-D2): bin/ integration of managed backups, rotation plans,
 * `backups ls|verify` and the fail-safe restore.
 *
 * Covers: managed backup + sidecars + anchor alignment; read-only dry-run;
 * real restore (pre-restore backup, reopened store, db.restore audit row);
 * the anchor-behind gate for older backups; refusal of corrupt backups with
 * the live database untouched; rotation dry-run vs --apply; strict flags.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { auditJson, cleanup, makeHome, runCli, runOk, seedCommitment } from './bin-ops-fixture.js'

function managedBackups(home) {
  const dir = join(home, 'backups')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => /^state-.*\.db$/.test(name)).sort()
}

function commitCount(home) {
  return JSON.parse(runOk(home, ['commit', 'ls', '--json']).stdout).length
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('backup: managed backup writes .db + .sha256 + .anchor.json, aligns the audit anchor and is listable/verifiable', () => {
  const { root, home } = makeHome('backup-managed')
  try {
    seedCommitment(home)
    runOk(home, ['audit', '--write-anchor'])
    const before = auditJson(home)
    const out = runOk(home, ['backup'])
    assert.match(out.stdout, /backup: .*state-.*\.db \(/)
    assert.match(out.stdout, /sidecars sha256=yes anchor=yes/)
    const backups = managedBackups(home)
    assert.equal(backups.length, 1)
    const file = join(home, 'backups', backups[0])
    assert.ok(existsSync(file))
    assert.ok(existsSync(file + '.sha256'))
    assert.ok(existsSync(file + '.anchor.json'))
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const after = auditJson(home)
    assert.equal(after.anchor.status, 'match', 'a fresh backup must not leave the live anchor grown/behind')
    assert.equal(after.anchor.count, before.head.count)
    const listed = JSON.parse(runOk(home, ['backups', 'ls', '--json']).stdout)
    assert.equal(listed.count, 1)
    assert.equal(listed.entries[0].name, backups[0])
    assert.equal(listed.entries[0].sidecars.sha256, true)
    const verified = JSON.parse(runOk(home, ['backups', 'verify', '--json']).stdout)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
    assert.equal(verified.results[0].ok, true)
  } finally { cleanup(root) }
})

test('restore: dry-run is read-only; --yes installs the backup, reopens the store, audits db.restore and refreshes the anchor', () => {
  const { root, home } = makeHome('restore-apply')
  try {
    seedCommitment(home)
    runOk(home, ['backup'])
    const backupName = managedBackups(home)[0]
    const backupPath = join(home, 'backups', backupName)
    const dbPath = join(home, 'state.db')
    const beforeStat = statSync(dbPath)
    const dry = runOk(home, ['restore', backupPath, '--dry-run'])
    assert.match(dry.stdout, /restore: dry-run \(no changes\)/)
    assert.match(dry.stdout, /backup: .*audit=\d+ entries, chain=verified/)
    assert.equal(statSync(dbPath).mtimeMs, beforeStat.mtimeMs, 'a dry-run must not touch the live database')
    assert.ok(!String(runOk(home, ['backups', 'ls']).stdout).includes('pre-restore'))

    seedCommitment(home, '备份之后新增')
    assert.equal(commitCount(home), 2)
    const applied = runOk(home, ['restore', backupPath, '--yes', '--allow-anchor-behind'])
    assert.match(applied.stdout, /restore: done/)
    assert.match(applied.stdout, /audit: db.restore seq \d+/)
    assert.match(applied.stdout, /audit: anchor refreshed/)
    assert.equal(commitCount(home), 1, 'the restored ledger is back to the backup moment')
    const backupsAfter = managedBackups(home)
    assert.ok(backupsAfter.some((name) => name.includes('-pre-restore')), 'a pre-restore safety backup must be kept')
    const audit = auditJson(home)
    assert.equal(audit.ok, true)
    assert.equal(audit.anchor.status, 'match')
    const rows = JSON.parse(runOk(home, ['audit', '--json']).stdout).entries.filter((row) => row.action === 'db.restore')
    assert.equal(rows.length, 1)
    assert.match(rows[0].reason, /from=state-.*\.db/)
    assert.doesNotMatch(rows[0].reason, /\//, 'audit reasons must not carry absolute paths')
  } finally { cleanup(root) }
})

test('restore: an older-than-anchor backup needs --allow-anchor-behind (no silent time travel)', () => {
  const { root, home } = makeHome('restore-behind')
  try {
    seedCommitment(home)
    runOk(home, ['backup'])
    const backupPath = join(home, 'backups', managedBackups(home)[0])
    seedCommitment(home, '之后的事')
    runOk(home, ['audit', '--write-anchor'])
    const blocked = runCli(home, ['restore', backupPath, '--yes'])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stdout + blocked.stderr, /E_AUDIT_ANCHOR_BEHIND/)
    assert.match(blocked.stderr + blocked.stdout, /--allow-anchor-behind/)
    assert.equal(commitCount(home), 2, 'a refused restore must not change the ledger')
    const allowed = runOk(home, ['restore', backupPath, '--yes', '--allow-anchor-behind'])
    assert.match(allowed.stdout, /restore: done/)
    assert.equal(commitCount(home), 1)
  } finally { cleanup(root) }
})

test('restore: a corrupt backup is refused before anything is touched', () => {
  const { root, home } = makeHome('restore-corrupt')
  try {
    seedCommitment(home)
    const dbPath = join(home, 'state.db')
    const beforeStat = statSync(dbPath)
    const bad = join(root, 'not-a-ledger.db')
    writeFileSync(bad, 'this is not a sqlite database at all\n')
    const dry = runCli(home, ['restore', bad, '--dry-run'])
    assert.equal(dry.status, 1)
    assert.match(dry.stderr + dry.stdout, /E_BACKUP_/)
    const apply = runCli(home, ['restore', bad, '--yes'])
    assert.equal(apply.status, 1)
    assert.match(apply.stderr + apply.stdout, /E_BACKUP_/)
    assert.equal(statSync(dbPath).mtimeMs, beforeStat.mtimeMs, 'the live database must be untouched')
    assert.equal(commitCount(home), 1)
  } finally { cleanup(root) }
})

test('backup: an explicit path keeps the legacy copy behaviour and never participates in rotation', () => {
  const { root, home } = makeHome('backup-explicit')
  try {
    seedCommitment(home)
    const target = join(root, 'explicit', 'copy.db')
    const out = runOk(home, ['backup', target])
    assert.match(out.stdout, /backup: .*copy\.db/)
    assert.ok(existsSync(target))
    assert.ok(existsSync(target + '.sha256'))
    const refused = runCli(home, ['backup', target, '--keep', 'daily=1'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /never participates in rotation/)
    const byOut = join(root, 'out', 'copy2.db')
    runOk(home, ['backup', '--out', byOut])
    assert.ok(existsSync(byOut))
    assert.equal(managedBackups(home).length, 0, 'explicit copies must not create managed backups')
  } finally { cleanup(root) }
})

test('backup --keep: rotation is a dry-run by default and only --apply deletes (managed dir only)', async () => {
  const { root, home } = makeHome('backup-rotation')
  try {
    seedCommitment(home)
    for (let index = 0; index < 3; index++) {
      runOk(home, ['backup'])
      await sleep(15)
    }
    const before = managedBackups(home).length
    const dry = runCli(home, ['backup', '--keep', 'daily=1'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /rotation: dry-run would delete \d+ backup\(s\)/)
    const afterDry = managedBackups(home)
    assert.equal(afterDry.length, before + 1, 'dry-run still writes the new backup but deletes nothing')
    const applied = runCli(home, ['backup', '--keep', 'daily=1', '--apply'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.match(applied.stdout, /rotation: deleted \d+ backup\(s\)/)
    const afterApply = managedBackups(home)
    assert.ok(afterApply.length < afterDry.length, 'apply must delete rotation victims')
    assert.ok(afterApply.length >= 2, 'the newest and the newest readable backup are always kept')
    const verified = JSON.parse(runOk(home, ['backups', 'verify', '--json']).stdout)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
    const outside = join(root, 'outside.db')
    writeFileSync(outside, 'not managed\n')
    assert.ok(existsSync(outside), 'files outside <HOME>/backups are never rotation victims')
  } finally { cleanup(root) }
})

test('backup/backups/restore: unknown flags and bad subcommands fail closed with E_USAGE', () => {
  const { root, home } = makeHome('backup-flags')
  try {
    seedCommitment(home)
    const cases = [
      [['backup', '--bogus'], /E_USAGE/],
      [['backup', '--apply'], /E_USAGE/],
      [['backups', 'frobnicate'], /E_USAGE/],
      [['backups', 'ls', '--bogus'], /E_USAGE/],
      [['restore'], /E_USAGE/],
      [['restore', 'x.db', '--bogus'], /E_USAGE/],
      [['restore', 'x.db', '--yes', '--dry-run'], /E_USAGE/],
    ]
    for (const [args, pattern] of cases) {
      const result = runCli(home, args)
      assert.equal(result.status, 1, args.join(' ') + ' must exit 1')
      assert.match(result.stderr, pattern, args.join(' '))
    }
    const empty = runOk(home, ['backups', 'ls'])
    assert.match(empty.stdout, /backups: none in /)
    const json = JSON.parse(runOk(home, ['backups', 'verify', '--json']).stdout)
    assert.equal(json.ok, true)
    assert.equal(json.count, 0)
  } finally { cleanup(root) }
})
