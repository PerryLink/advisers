import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { skipOnWindows } from './win-compat.mjs'
import { runLocalOcr } from '../lib/ocr.js'
import { runLocalTimestamp } from '../lib/timestamp.js'
import { sendNotification } from '../lib/notify.js'

// Security audit 2026-11-17 SEC2-03: the OCR / timestamp / notification adapters
// are local third-party programs, but their spawn() calls inherited the whole
// process environment. A configured adapter could read ADVISERS_API_KEY,
// ADVISERS_AUDIT_KEY (the audit HMAC key) and the vault/sync/export
// passphrases. Each adapter now spawns with an explicit OS-basics allowlist.

const SECRETS = Object.freeze({
  ADVISERS_API_KEY: 'sk-SECRET-API-KEY-123',
  ADVISERS_AUDIT_KEY: 'f'.repeat(64),
  ADVISERS_VAULT_PASSPHRASE: 'vault-SECRET-passphrase',
  ADVISERS_SYNC_PASSPHRASE: 'sync-SECRET-passphrase',
  ADVISERS_EXPORT_PASSPHRASE: 'export-SECRET-passphrase',
  ADVISERS_BASE_URL: 'https://secret-gateway.invalid',
  ADVISERS_OCR_CMD: '/secret/ocr',
  ADVISERS_TIMESTAMP_CMD: '/secret/tsa',
  ADVISERS_NOTIFY_CMD: '/secret/notify',
  CUSTOM_UNRELATED_SECRET: 'custom-SECRET-value',
})

function withSecrets(body) {
  const saved = {}
  for (const [key, value] of Object.entries(SECRETS)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined
    process.env[key] = value
  }
  try {
    return body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function assertNoSecrets(dump, adapter) {
  for (const [key, value] of Object.entries(SECRETS)) {
    assert.equal(dump.includes(value), false, adapter + ' subprocess saw ' + key)
    if (key.startsWith('ADVISERS_')) {
      assert.equal(dump.split('\n').some((line) => line.startsWith(key + '=')), false, adapter + ' subprocess inherited ' + key)
    }
  }
  assert.equal(dump.split('\n').some((line) => line.startsWith('ADVISERS_')), false, adapter + ' subprocess inherited an ADVISERS_* variable')
  assert.match(dump, /(?:^|\n)PATH=/, adapter + ' subprocess keeps an OS-basics PATH')
}

test('OCR adapter subprocess cannot see Advisers credentials', async (t) => {
  if (skipOnWindows(t, 'OCR external adapter commands are spawned as a single executable path on Windows, so a POSIX #!/bin/sh probe cannot run (quoted-argv adapter contract tracked; docs/WINDOWS.md section 8, windows triage B)')) return
  const root = mkdtempSync(join(tmpdir(), 'advisers-env-ocr-'))
  try {
    writeFileSync(join(root, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const script = join(root, 'ocr-env-probe.sh')
    writeFileSync(script, '#!/bin/sh\necho "识别文本"\nenv | sort\n')
    chmodSync(script, 0o700)
    const output = await withSecrets(() => runLocalOcr('scan.png', { cwd: root, cmd: script }))
    assert.match(output, /识别文本/)
    assertNoSecrets(output, 'OCR')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('timestamp adapter subprocess cannot see Advisers credentials', async (t) => {
  if (skipOnWindows(t, 'timestamp external adapter commands are spawned as a single executable path on Windows, so a POSIX #!/bin/sh probe cannot run (quoted-argv adapter contract tracked; docs/WINDOWS.md section 8, windows triage B)')) return
  const root = mkdtempSync(join(tmpdir(), 'advisers-env-ts-'))
  try {
    writeFileSync(join(root, 'pack.txt'), 'evidence')
    const script = join(root, 'timestamp-env-probe.sh')
    writeFileSync(script, '#!/bin/sh\necho "TSA fake proof"\nenv | sort\n')
    chmodSync(script, 0o700)
    const output = await withSecrets(() => runLocalTimestamp('pack.txt', { cwd: root, cmd: script }))
    assert.match(output, /TSA fake proof/)
    assertNoSecrets(output, 'timestamp')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('notification adapter subprocess cannot see Advisers credentials', async (t) => {
  if (skipOnWindows(t, 'notification external adapter commands are spawned as a single executable path on Windows, so a POSIX #!/bin/sh probe cannot run (quoted-argv adapter contract tracked; docs/WINDOWS.md section 8, windows triage B)')) return
  const root = mkdtempSync(join(tmpdir(), 'advisers-env-notify-'))
  try {
    const dumpPath = join(root, 'env.dump')
    const script = join(root, 'notify-env-probe.sh')
    writeFileSync(script, '#!/bin/sh\nenv | sort > ' + JSON.stringify(dumpPath) + '\n')
    chmodSync(script, 0o700)
    const result = await withSecrets(() => sendNotification({ title: 't', body: 'b', cmd: script }))
    assert.equal(result.sent, true)
    assert.equal(result.channel, 'custom')
    assertNoSecrets(readFileSync(dumpPath, 'utf8'), 'notification')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
