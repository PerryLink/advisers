#!/usr/bin/env node
/**
 * 0.4.3 task-79 / release item 043-6: end-to-end restore drill.
 *
 * What it proves, against a throwaway ADVISERS_HOME created with mkdtemp under
 * the OS temp directory (the user's real home is never read or written):
 *
 *   init -> seed one commitment + one KB document -> managed backup
 *        -> mutate the ledger (add a commitment) and delete the KB document
 *        -> restore the backup (time-travel is explicit: --allow-anchor-behind)
 *        -> ledger/KB counts and the export dataDigest return to the backup
 *           moment; the audit chain holds exactly the backup rows plus the new
 *           `db.restore` row; `doctor --check-db` is green.
 *
 * The drill also asserts the safety rails around that happy path:
 *   - restoring the older backup is REFUSED without --allow-anchor-behind, so
 *     the drill's time-travel is deliberate and the audit-anchor gate is live;
 *   - the managed backup verifies (`backups verify`: sha256 + anchor sidecars)
 *     and the backup anchor head equals the audit head observed before backup;
 *   - a pre-restore safety backup exists and the managed backups still verify
 *     after the restore.
 *
 * Output: exactly one JSON object on stdout, `PASS`/`FAIL` in `status`. Step
 * progress and human-readable failures go to stderr. Exit 0 = PASS, 1 = FAIL
 * (including usage errors). The drill never needs the network or a model key.
 *
 * Usage: node scripts/restore-drill.mjs [--bin <advisers-cli.js>] [--keep]
 *   --bin   CLI entry point to drive (default: packages/advisers/bin/advisers.js)
 *   --keep  keep the temporary home for post-mortem debugging
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DRILL = 'restore-drill'
const DRILL_VERSION = 1
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BIN = join(REPO_ROOT, 'packages', 'advisers', 'bin', 'advisers.js')
const CLI_TIMEOUT_MS = 120000
const MAX_BUFFER = 64 * 1024 * 1024
const OUTPUT_TAIL = 2000
const AUDIT_ROW_ACTION = 'db.restore'

/** An expected drill failure: reported as FAIL JSON instead of a stack trace. */
class DrillError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'DrillError'
    this.code = options.code ?? null
    this.detail = options.detail ?? null
  }
}

function usageText() {
  return [
    'usage: node scripts/restore-drill.mjs [--bin <advisers-cli.js>] [--keep]',
    '',
    'End-to-end backup -> mutate -> restore drill on a throwaway ADVISERS_HOME.',
    'Prints one PASS/FAIL JSON object on stdout; exit 0 = PASS, 1 = FAIL.',
    '  --bin <path>  CLI entry point (default: packages/advisers/bin/advisers.js)',
    '  --keep        keep the temporary home for debugging (path is in the JSON)',
  ].join('\n')
}

function parseArgs(argv) {
  const options = { bin: DEFAULT_BIN, keep: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--bin') {
      const value = argv[index + 1]
      index += 1
      if (!value) throw new DrillError('--bin requires a path', { code: 'E_USAGE' })
      options.bin = resolve(value)
    } else if (arg === '--keep') {
      options.keep = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new DrillError(`unknown argument: ${arg}`, { code: 'E_USAGE' })
    }
  }
  return options
}

function outputTail(value, limit = OUTPUT_TAIL) {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(-limit) : text
}

function log(line) {
  console.error(`restore-drill: ${line}`)
}

function assertDrill(condition, message, code = 'E_DRILL_ASSERT', detail = null) {
  if (!condition) throw new DrillError(message, { code, detail })
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function isInside(base, target) {
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** DIGEST scope: `export --all` ledger + every data table except `audit`. */
function exportDigest(payload) {
  const data = payload?.data
  assertDrill(data && typeof data === 'object' && !Array.isArray(data), 'export --all is missing its data tables', 'E_EXPORT_SHAPE')
  const stableData = {}
  for (const table of Object.keys(data).sort()) {
    if (table === 'audit') continue
    stableData[table] = data[table]
  }
  return sha256Buffer(JSON.stringify({ ledger: payload.ledger, data: stableData }))
}

/** Create the throwaway home; refuse to place it outside the OS temp dir. */
function makeTempHome() {
  const realTmp = realpathSync(tmpdir())
  const root = mkdtempSync(join(tmpdir(), 'advisers-restore-drill-'))
  const realRoot = realpathSync(root)
  const home = join(realRoot, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  assertDrill(isInside(realTmp, realRoot), `temporary home escaped the OS temp directory: ${realRoot}`, 'E_DRILL_HOME')
  const inheritedHome = process.env.ADVISERS_HOME ?? null
  if (inheritedHome && isAbsolute(inheritedHome)) {
    try {
      const realInherited = realpathSync(inheritedHome)
      assertDrill(!isInside(realInherited, realRoot), `temporary home must not be inside the inherited ADVISERS_HOME: ${realRoot}`, 'E_DRILL_HOME')
    } catch (error) {
      if (error instanceof DrillError) throw error
    }
  }
  return { root: realRoot, home, inheritedHome }
}

/** Delete only a path proven to be under the OS temp dir; never the real home. */
function cleanupTempHome(state, keep) {
  if (!state.root) return { removed: false, reason: 'no temporary home was created' }
  if (keep) return { removed: false, reason: 'kept (--keep)' }
  try {
    const realTmp = realpathSync(tmpdir())
    const realRoot = realpathSync(state.root)
    assertDrill(isInside(realTmp, realRoot), `refusing to delete a temporary home outside the OS temp directory: ${realRoot}`, 'E_DRILL_CLEANUP')
    assertDrill(basename(realRoot).startsWith('advisers-restore-drill-'), `refusing to delete an unexpected temporary path: ${realRoot}`, 'E_DRILL_CLEANUP')
    rmSync(realRoot, { recursive: true, force: true })
    return { removed: !existsSync(realRoot), reason: null }
  } catch (error) {
    return { removed: false, reason: `cleanup failed: ${error.message}` }
  }
}

const OVERRIDDEN_ENV = [
  'ADVISERS_HOME',
  'ADVISERS_STORE',
  'ADVISERS_ACCEPT_TOS',
  'ADVISERS_NO_MODEL',
  'ADVISERS_CORE_LOCAL',
  'ADVISERS_OFFICE_LOCAL',
  'ADVISERS_AUDIT_KEY',
  'ADVISERS_API_KEY',
  'ADVISERS_BASE_URL',
  'ADVISERS_MODEL',
  'ADVISERS_EXPORT_PASSPHRASE',
  'ADVISERS_VAULT_PASSPHRASE',
]

/** Isolated child env: our temporary home, SQLite, TOS pre-accepted, no model. */
function childEnv(home) {
  const env = { ...process.env }
  for (const key of OVERRIDDEN_ENV) delete env[key]
  return Object.assign(env, {
    ADVISERS_HOME: home,
    ADVISERS_STORE: 'sqlite',
    ADVISERS_ACCEPT_TOS: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
  })
}

function runCli(state, label, args, options = {}) {
  const result = spawnSync(process.execPath, [state.bin, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(state.home),
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
  const detail = { args, exitCode: result.status ?? null, signal: result.signal ?? null, stdout: outputTail(result.stdout), stderr: outputTail(result.stderr) }
  if (result.error) throw new DrillError(`${label}: could not start the CLI (${result.error.message})`, { code: 'E_CLI_SPAWN', detail })
  if (result.signal) throw new DrillError(`${label}: the CLI was killed by ${result.signal}`, { code: 'E_CLI_SIGNAL', detail })
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new DrillError(`${label}: advisers ${args.join(' ')} exited ${result.status}`, { code: 'E_CLI_EXIT', detail })
  }
  return result
}

function runJson(state, label, args, options = {}) {
  const result = runCli(state, label, args, options)
  assertDrill(result.stdout.trim() !== '', `${label}: the CLI printed no JSON`, 'E_CLI_NO_JSON', { args, exitCode: result.status ?? null, stderr: outputTail(result.stderr) })
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new DrillError(`${label}: stdout is not JSON (${error.message})`, { code: 'E_CLI_JSON', detail: { args, exitCode: result.status ?? null, stdout: outputTail(result.stdout), stderr: outputTail(result.stderr) } })
  }
}

function runStep(state, name, fn) {
  state.currentStep = name
  const startedAt = Date.now()
  log(`${name} ...`)
  const result = fn()
  const durationMs = Date.now() - startedAt
  state.steps.push({ name, ok: true, durationMs })
  log(`${name}: ok (${durationMs} ms)`)
  state.currentStep = null
  return result
}

function runDrill(state, options) {
  runStep(state, 'preflight', () => {
    assertDrill(existsSync(options.bin), `CLI entry not found: ${options.bin}`, 'E_CLI_MISSING')
    assertDrill(statSync(options.bin).isFile(), `CLI entry is not a file: ${options.bin}`, 'E_CLI_MISSING')
    const created = makeTempHome()
    state.root = created.root
    state.home = created.home
    state.inheritedHome = created.inheritedHome
    state.checks.isolation = {
      temporaryHome: true,
      homeInsideOsTempDir: isInside(realpathSync(tmpdir()), state.root),
      inheritedAdvisersHomeIgnored: state.inheritedHome,
    }
  })

  runStep(state, 'init', () => {
    runCli(state, 'init', ['init'])
    assertDrill(existsSync(join(state.home, 'soul.md')), 'init did not create soul.md', 'E_INIT')
    assertDrill(existsSync(join(state.home, 'audit.key')), 'init did not create the local audit key', 'E_INIT')
  })

  runStep(state, 'seed', () => {
    const seedPath = join(state.root, 'drill-note.md')
    writeFileSync(seedPath, '# Restore drill note\n\nA seeded knowledge document for the backup/restore round trip.\n', { mode: 0o600 })
    state.seedPath = seedPath
    runCli(state, 'seed-commit', ['commit', 'add', 'restore drill commitment', '--quote', 'restore drill commitment quote'])
    // The SQLite store and the TOS record are created by the first write command.
    assertDrill(existsSync(join(state.home, 'state.db')), 'the first write did not create the SQLite database', 'E_SEED')
    assertDrill(existsSync(join(state.home, 'tos.json')), 'the first write did not record the TOS acceptance', 'E_SEED')
    const added = runJson(state, 'seed-kb', ['kb', 'add', seedPath, '--title', 'Restore drill note', '--kind', 'note', '--json'])
    assertDrill(added.ok === true && Array.isArray(added.added) && added.added.length === 1, 'kb add did not add exactly one document', 'E_SEED', { stdout: outputTail(JSON.stringify(added)) })
    const doc = added.added[0]
    assertDrill(typeof doc.id === 'string' && doc.id.length > 0, 'kb add returned no document id', 'E_SEED')
    state.docId = doc.id
    // One `export --all` read gives the baseline dataDigest, the seed counts and
    // the audit head (the audit anchor is built from the same read snapshot), so
    // the drill needs no separate audit/list round trips before the backup.
    const exported = runJson(state, 'seed-export', ['export', '--all'])
    const auditRows = exported.data?.audit ?? []
    assertDrill(Array.isArray(auditRows) && auditRows.length > 0, 'the pre-backup export has no audit rows', 'E_SEED')
    const anchor = exported.auditAnchor
    assertDrill(anchor && anchor.format === 'advisers-audit-anchor' && anchor.count === auditRows.length, 'the pre-backup export has no usable audit anchor', 'E_SEED', { anchor })
    const ledgerCommits = exported.ledger?.commitments ?? []
    assertDrill(Array.isArray(ledgerCommits) && ledgerCommits.length === 1, 'expected exactly one seeded commitment', 'E_SEED', { commits: ledgerCommits.length })
    const kbDocuments = exported.data?.kb_documents ?? []
    assertDrill(Array.isArray(kbDocuments) && kbDocuments.length === 1 && kbDocuments[0].status === 'active', 'the seeded KB document is not in the export as active', 'E_SEED')
    state.expect.schemaVersion = exported.schemaVersion ?? added.schemaVersion ?? null
    state.expect.auditCount = auditRows.length
    state.expect.auditHeadHash = anchor.headHash ?? null
    assertDrill(typeof state.expect.auditHeadHash === 'string' && /^[0-9a-f]{64}$/.test(state.expect.auditHeadHash), 'the export audit anchor has no head hash', 'E_SEED')
    state.expect.auditRows = auditRows
    state.expect.commitCount = ledgerCommits.length
    state.expect.kbDocumentCount = kbDocuments.length
    state.expect.dataDigest = exportDigest(exported)
    state.checks.audit = { before: state.expect.auditCount, headHashBefore: state.expect.auditHeadHash }
    state.checks.counts = { commitsBefore: state.expect.commitCount, kbDocumentsBefore: state.expect.kbDocumentCount }
  })

  runStep(state, 'backup', () => {
    const backup = runJson(state, 'backup', ['backup', '--json'])
    assertDrill(backup.ok === true, 'backup reported failure', 'E_BACKUP', { backup })
    assertDrill(typeof backup.path === 'string' && existsSync(backup.path), 'the managed backup file does not exist', 'E_BACKUP', { backup })
    assertDrill(backup.audit?.count === state.expect.auditCount, 'the backup audit count does not match the seeded ledger', 'E_BACKUP', { backupAudit: backup.audit, expected: state.expect.auditCount })
    assertDrill(backup.audit?.headHash === state.expect.auditHeadHash, 'the backup audit head does not match the pre-backup audit head', 'E_BACKUP')
    const stat = statSync(backup.path)
    assertDrill(stat.isFile() && stat.size > 0 && stat.size === backup.bytes, 'the managed backup file size is wrong', 'E_BACKUP')
    if (process.platform !== 'win32') assertDrill((stat.mode & 0o777) === 0o600, 'the managed backup is not 0600', 'E_BACKUP')
    const actualSha = sha256Buffer(readFileSync(backup.path))
    assertDrill(actualSha === backup.sha256, 'the backup sha256 does not match its bytes', 'E_BACKUP')
    const shaSidecar = readFileSync(`${backup.path}.sha256`, 'utf8').trim()
    assertDrill(shaSidecar.startsWith(actualSha), 'the sha256 sidecar does not match the backup bytes', 'E_BACKUP')
    const anchorSidecar = JSON.parse(readFileSync(`${backup.path}.anchor.json`, 'utf8'))
    assertDrill(anchorSidecar.format === 'advisers-audit-anchor', 'the backup anchor sidecar has the wrong format', 'E_BACKUP')
    assertDrill(anchorSidecar.count === state.expect.auditCount && anchorSidecar.headHash === state.expect.auditHeadHash, 'the backup anchor sidecar does not match the audit head', 'E_BACKUP')
    state.backupPath = backup.path
    state.checks.backup = {
      name: basename(backup.path),
      bytes: backup.bytes,
      sha256: actualSha,
      auditCount: backup.audit?.count ?? null,
      anchorCount: anchorSidecar.count,
      anchorHeadHash: anchorSidecar.headHash,
    }
  })

  runStep(state, 'mutate', () => {
    runCli(state, 'mutate-commit', ['commit', 'add', 'post-backup commitment', '--quote', 'post-backup commitment quote'])
    runCli(state, 'mutate-kb-rm', ['kb', 'rm', state.docId])
    const exported = runJson(state, 'mutate-export', ['export', '--all'])
    const auditRows = exported.data?.audit ?? []
    assertDrill(auditRows.length > state.expect.auditCount, 'the mutation did not grow the audit chain', 'E_MUTATE', { auditRows: auditRows.length, expected: state.expect.auditCount })
    const ledgerCommits = exported.ledger?.commitments ?? []
    assertDrill(Array.isArray(ledgerCommits) && ledgerCommits.length === state.expect.commitCount + 1, 'the mutation did not add a commitment', 'E_MUTATE')
    const kbDocuments = exported.data?.kb_documents ?? []
    assertDrill(Array.isArray(kbDocuments) && kbDocuments.length === state.expect.kbDocumentCount && kbDocuments.every((document) => document.status !== 'active'), 'the mutation did not delete the KB document', 'E_MUTATE')
    const mutatedDigest = exportDigest(exported)
    assertDrill(mutatedDigest !== state.expect.dataDigest, 'the mutation did not change the export dataDigest', 'E_MUTATE')
    state.checks.audit.mutated = auditRows.length
    state.checks.audit.headHashMutated = exported.auditAnchor?.headHash ?? null
    state.checks.counts.commitsMutated = ledgerCommits.length
    state.checks.counts.kbDocumentsMutated = kbDocuments.filter((document) => document.status === 'active').length
    state.checks.dataDigest = { before: state.expect.dataDigest, mutated: mutatedDigest }
  })

  runStep(state, 'restore-plan', () => {
    const refused = runJson(state, 'restore-refuse', ['restore', state.backupPath, '--dry-run', '--json'], { allowFailure: true })
    assertDrill(refused.ok === false && refused.code === 'E_AUDIT_ANCHOR_BEHIND', 'restoring the older backup was not refused by the audit-anchor gate', 'E_RESTORE_PLAN', { refused })
    const plan = runJson(state, 'restore-plan', ['restore', state.backupPath, '--dry-run', '--allow-anchor-behind', '--json'])
    assertDrill(plan.ok === true && plan.mode === 'dry-run', 'the restore dry-run did not plan cleanly', 'E_RESTORE_PLAN', { plan })
    assertDrill(plan.backup?.audit?.count === state.expect.auditCount, 'the plan reads a different backup audit count', 'E_RESTORE_PLAN', { planBackup: plan.backup })
    assertDrill(plan.backup?.chainVerified === true, 'the plan did not verify the backup audit chain', 'E_RESTORE_PLAN')
    assertDrill(plan.sidecarAnchor?.present === true && plan.sidecarAnchor?.ok === true, 'the plan did not verify the backup anchor sidecar', 'E_RESTORE_PLAN')
    assertDrill(plan.anchor?.status === 'behind', 'the plan did not detect the anchor-behind time-travel', 'E_RESTORE_PLAN', { anchor: plan.anchor })
    assertDrill((plan.warnings ?? []).some((warning) => /time-travel|anchor/i.test(warning)), 'the plan did not warn about the explicit time-travel', 'E_RESTORE_PLAN', { warnings: plan.warnings })
    state.checks.restore = { anchorBehindRefused: refused.code }
  })

  runStep(state, 'restore-apply', () => {
    const restored = runJson(state, 'restore-apply', ['restore', state.backupPath, '--yes', '--allow-anchor-behind', '--json'])
    assertDrill(restored.ok === true && restored.mode === 'apply', 'the restore did not apply', 'E_RESTORE_APPLY', { restored })
    assertDrill(basename(restored.restoredFrom ?? '') === basename(state.backupPath), 'the restore used a different backup file', 'E_RESTORE_APPLY', { restored })
    assertDrill(restored.schemaVersion === state.expect.schemaVersion, 'the restored schema version changed', 'E_RESTORE_APPLY')
    assertDrill(restored.audit?.count === state.expect.auditCount, 'the restored audit count is not the backup count', 'E_RESTORE_APPLY', { restoredAudit: restored.audit })
    assertDrill(restored.audit?.headHash === state.expect.auditHeadHash, 'the restored audit head is not the backup head', 'E_RESTORE_APPLY')
    assertDrill(restored.auditRow?.action === AUDIT_ROW_ACTION, 'the db.restore audit row is missing', 'E_RESTORE_APPLY', { auditRow: restored.auditRow })
    assertDrill(restored.auditRow?.seq === state.expect.auditCount + 1, 'the db.restore audit row has the wrong sequence', 'E_RESTORE_APPLY')
    assertDrill(restored.anchor?.ok === true, 'the post-restore audit anchor was not written', 'E_RESTORE_APPLY', { anchor: restored.anchor })
    assertDrill(typeof restored.preRestoreBackup === 'string' && existsSync(restored.preRestoreBackup), 'the pre-restore safety backup is missing', 'E_RESTORE_APPLY', { preRestoreBackup: restored.preRestoreBackup })
    assertDrill(basename(restored.preRestoreBackup).includes('pre-restore'), 'the pre-restore safety backup has an unexpected name', 'E_RESTORE_APPLY')
    state.checks.restore.preRestoreBackup = basename(restored.preRestoreBackup)
    state.checks.restore.auditRowSeq = restored.auditRow?.seq ?? null
  })

  runStep(state, 'verify', () => {
    const expectedAuditCount = state.expect.auditCount + 1
    const audit = runJson(state, 'verify-audit', ['audit', '--json'])
    assertDrill(audit.ok === true && audit.chain?.ok === true, 'the audit chain is not healthy after the restore', 'E_VERIFY', { audit })
    assertDrill(audit.chain?.count === expectedAuditCount, 'the audit count is not the backup count plus the db.restore row', 'E_VERIFY', { audit: audit.chain, expectedAuditCount })
    assertDrill(audit.head?.count === expectedAuditCount && audit.head?.lastSeq === expectedAuditCount, 'the audit head is not the expected head', 'E_VERIFY', { head: audit.head, expectedAuditCount })
    assertDrill(audit.entries?.[0]?.action === AUDIT_ROW_ACTION, 'the newest audit entry is not db.restore', 'E_VERIFY', { newest: audit.entries?.[0] })
    assertDrill(audit.anchor?.ok === true && audit.anchor?.status === 'match', 'the audit anchor does not match the restored database', 'E_VERIFY', { anchor: audit.anchor })
    const exported = runJson(state, 'verify-export', ['export', '--all'])
    const digest = exportDigest(exported)
    assertDrill(digest === state.expect.dataDigest, 'the post-restore export dataDigest differs from the pre-backup digest', 'E_VERIFY', { before: state.expect.dataDigest, after: digest })
    const auditRows = exported.data?.audit ?? []
    assertDrill(auditRows.length === state.expect.auditRows.length + 1, 'the restored audit table is not the backup rows plus db.restore', 'E_VERIFY')
    assertDrill(JSON.stringify(auditRows.slice(0, state.expect.auditRows.length)) === JSON.stringify(state.expect.auditRows), 'the restored audit rows do not return to the backup moment', 'E_VERIFY')
    assertDrill(auditRows[auditRows.length - 1]?.action === AUDIT_ROW_ACTION, 'the newest exported audit row is not db.restore', 'E_VERIFY')
    const ledgerCommits = exported.ledger?.commitments ?? []
    assertDrill(Array.isArray(ledgerCommits) && ledgerCommits.length === state.expect.commitCount, 'the exported commitment count is not the backup count', 'E_VERIFY')
    const exportedKb = exported.data?.kb_documents ?? []
    assertDrill(Array.isArray(exportedKb) && exportedKb.length === state.expect.kbDocumentCount && exportedKb.every((document) => document.status === 'active'), 'the exported KB documents are not the backup documents', 'E_VERIFY')
    const commits = runJson(state, 'verify-commit-ls', ['commit', 'ls', '--json'])
    assertDrill(Array.isArray(commits) && commits.length === state.expect.commitCount, 'the commitment count did not return to the backup moment', 'E_VERIFY', { commits: commits.length, expected: state.expect.commitCount })
    const kbList = runJson(state, 'verify-kb-ls', ['kb', 'ls', '--json'])
    assertDrill(Array.isArray(kbList.documents) && kbList.documents.length === state.expect.kbDocumentCount, 'the KB document count did not return to the backup moment', 'E_VERIFY', { documents: kbList.documents.length, expected: state.expect.kbDocumentCount })
    assertDrill(kbList.documents.every((document) => document.status === 'active'), 'the deleted KB document did not come back active', 'E_VERIFY')
    const verified = runJson(state, 'verify-backups', ['backups', 'verify', '--json'])
    assertDrill(verified.ok === true, 'backups verify reported failure after the restore', 'E_VERIFY', { verified })
    const managed = (verified.results ?? []).find((entry) => entry.name === basename(state.backupPath))
    assertDrill(managed?.ok === true && managed.auditCount === state.expect.auditCount, 'the managed backup no longer verifies after the restore', 'E_VERIFY', { managed })
    assertDrill((verified.results ?? []).some((entry) => String(entry.name).includes('-pre-restore')), 'the pre-restore backup is not listed by backups verify', 'E_VERIFY')
    const doctor = runJson(state, 'verify-doctor', ['doctor', '--check-db', '--json'])
    assertDrill(doctor.ok === true, 'doctor --check-db reported failure after the restore', 'E_VERIFY', { doctor })
    const failing = (doctor.checks ?? []).filter((check) => check.ok !== true)
    assertDrill(failing.length === 0, 'doctor --check-db has failing checks after the restore', 'E_VERIFY', { failing })
    state.checks.audit.after = audit.chain.count
    state.checks.audit.headHashAfter = audit.head?.headHash ?? null
    state.checks.counts.commitsAfter = commits.length
    state.checks.counts.kbDocumentsAfter = kbList.documents.length
    state.checks.dataDigest.after = digest
    state.checks.dataDigest.equal = digest === state.expect.dataDigest
    state.checks.dataDigest.scope = 'export --all ledger + data tables excluding audit'
    state.checks.backupsVerify = { managedOk: managed.ok === true, preRestorePresent: true }
    state.checks.doctor = { ok: doctor.ok === true, failedChecks: failing.map((check) => check.name) }
  })
}

function emit(payload) {
  console.log(JSON.stringify(payload))
}

function main() {
  const startedAt = Date.now()
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    emit({
      ok: false, status: 'FAIL', drill: DRILL, version: DRILL_VERSION,
      node: process.version, platform: process.platform, home: null, kept: false,
      cleanup: { removed: false, reason: 'no temporary home was created' },
      failedStep: null, steps: [], durationMs: Date.now() - startedAt,
      error: { message: error.message, code: error.code ?? 'E_USAGE', detail: error.detail ?? null },
    })
    console.error(`restore-drill: FAIL (usage): ${error.message}`)
    process.exitCode = 1
    return
  }
  if (options.help) { console.log(usageText()); return }

  const state = {
    bin: options.bin,
    root: null,
    home: null,
    inheritedHome: process.env.ADVISERS_HOME ?? null,
    steps: [],
    checks: {},
    expect: {},
    currentStep: null,
  }
  try {
    runDrill(state, options)
    const cleanup = cleanupTempHome(state, options.keep)
    emit({
      ok: true, status: 'PASS', drill: DRILL, version: DRILL_VERSION,
      node: process.version, platform: process.platform,
      binary: state.bin, home: state.home,
      kept: options.keep, cleanup,
      durationMs: Date.now() - startedAt,
      steps: state.steps, checks: state.checks,
    })
    log(`PASS in ${Date.now() - startedAt} ms`)
    if (cleanup.removed !== true && cleanup.reason) log(`cleanup: ${cleanup.reason}`)
    process.exitCode = 0
  } catch (error) {
    const cleanup = cleanupTempHome(state, options.keep)
    emit({
      ok: false, status: 'FAIL', drill: DRILL, version: DRILL_VERSION,
      node: process.version, platform: process.platform,
      binary: state.bin, home: state.home,
      kept: options.keep, cleanup,
      durationMs: Date.now() - startedAt,
      failedStep: state.currentStep, steps: state.steps,
      error: {
        message: error.message,
        code: error.code ?? 'E_DRILL',
        detail: error.detail ?? null,
      },
    })
    log(`FAIL${state.currentStep ? ` at ${state.currentStep}` : ''}: ${error.message}`)
    if (error.detail?.stderr) log(`stderr tail: ${error.detail.stderr}`)
    if (options.keep && state.home) log(`kept temporary home at ${state.home}`)
    process.exitCode = 1
  }
}

main()
