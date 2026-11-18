import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RECALC_ENV,
  RECALC_ENV_KEYS,
  buildXlsx,
  recalcEnv,
  verifyOffice,
} from '../src/index.ts'

// Security audit 2026-11-17 SEC3-04: the formula-recalculation hook
// (ADVISERS_VERIFY_RECALC_CMD) is a local third-party program, but its
// execFileSync() inherited the whole process environment. It now spawns with
// the same OS-basics allowlist as the OCR/timestamp/notification adapters.

const SECRETS: Record<string, string> = {
  ADVISERS_API_KEY: 'sk-SECRET-API-KEY-123',
  ADVISERS_AUDIT_KEY: 'f'.repeat(64),
  ADVISERS_VAULT_PASSPHRASE: 'vault-SECRET-passphrase',
  ADVISERS_SYNC_PASSPHRASE: 'sync-SECRET-passphrase',
  ADVISERS_EXPORT_PASSPHRASE: 'export-SECRET-passphrase',
  ADVISERS_IMAP_PASS: 'imap-SECRET-password',
  CUSTOM_UNRELATED_SECRET: 'custom-SECRET-value',
}

async function withSecrets<T>(body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(SECRETS)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined
    process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('recalcEnv is an OS-basics allowlist that filters every non-allowlisted key', () => {
  const filtered = recalcEnv({
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    SystemRoot: 'C:\\Windows',
    ADVISERS_API_KEY: 'sk-SECRET',
    ADVISERS_VERIFY_RECALC_CMD: '/secret/recalc',
    CUSTOM_UNRELATED_SECRET: 'custom',
  })
  assert.deepEqual(filtered, { PATH: '/usr/bin:/bin', HOME: '/home/user', SystemRoot: 'C:\\Windows' })
  assert.ok(RECALC_ENV_KEYS.includes('PATH'))
  assert.ok(RECALC_ENV_KEYS.includes('SystemRoot'))
  assert.ok(RECALC_ENV_KEYS.includes('TMPDIR'))
  for (const key of RECALC_ENV_KEYS) assert.equal(key.startsWith('ADVISERS_'), false, key)
})

test('the recalculation subprocess cannot see Advisers credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adv023-recalc-env-'))
  const previous = process.env[RECALC_ENV]
  try {
    const dumpPath = join(dir, 'env.dump')
    const probe = join(dir, 'probe.mjs')
    writeFileSync(probe, 'import { writeFileSync } from "node:fs"\nwriteFileSync(' + JSON.stringify(dumpPath) + ', JSON.stringify(process.env))\n')
    process.env[RECALC_ENV] = process.execPath + ' ' + probe
    const xlsx = await buildXlsx({ columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] })
    const result = await withSecrets(() => verifyOffice(xlsx, 'xlsx'))
    const recalc = result.checks.find((item) => item.id === 'xlsx.recalc')
    assert.ok(recalc)
    assert.equal(recalc.skipped, undefined)
    assert.equal(recalc.ok, true, recalc.detail)
    assert.ok(result.layers.includes('recalc'))
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, string>
    for (const [key, value] of Object.entries(SECRETS)) {
      assert.equal(JSON.stringify(dump).includes(value), false, 'recalc subprocess saw ' + key)
      if (key.startsWith('ADVISERS_')) assert.equal(key in dump, false, 'recalc subprocess inherited ' + key)
    }
    assert.equal(Object.keys(dump).some((key) => key.startsWith('ADVISERS_')), false, 'recalc subprocess inherited an ADVISERS_* variable')
    assert.equal(typeof dump.PATH, 'string')
  } finally {
    if (previous === undefined) delete process.env[RECALC_ENV]
    else process.env[RECALC_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
