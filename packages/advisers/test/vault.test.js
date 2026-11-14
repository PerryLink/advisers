import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptJson, encryptJson, isVaultEnvelope } from '../lib/vault.js'

test('P2: encrypted export round-trips and rejects wrong pass/tamper', () => {
  const payload = { version: 'x', ledger: { matters: [{ id: 'm1', title: '秘密客户' }], commitments: [{ id: 'cm1', action: '发报价' }] } }
  const env = encryptJson(payload, 'correct horse battery')
  assert.ok(isVaultEnvelope(env))
  assert.equal(JSON.stringify(env).includes('秘密客户'), false)
  assert.deepEqual(decryptJson(env, 'correct horse battery'), payload)
  assert.throws(() => decryptJson(env, 'wrong passphrase'), /wrong passphrase/)
  const tampered = { ...env, data: Buffer.from('tampered').toString('base64') }
  assert.throws(() => decryptJson(tampered, 'correct horse battery'), /wrong passphrase|tampered/)
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

test('E9-T3: vault seal removes plaintext and unseal restores the DB', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-vault-cli-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_VAULT_PASSPHRASE: 'correct horse battery' }
  try {
    execFileSync(process.execPath, [bin, 'commit', 'add', '秘密承诺', '--quote', 'q'], { env, encoding: 'utf8' })
    execFileSync(process.execPath, [bin, 'vault', 'seal', '--remove'], { env, encoding: 'utf8' })
    assert.equal(existsSync(join(home, 'state.db')), false)
    assert.equal(readFileSync(join(home, 'state.db.vault'), 'utf8').includes('秘密承诺'), false)
    execFileSync(process.execPath, [bin, 'vault', 'unseal'], { env, encoding: 'utf8' })
    assert.match(execFileSync(process.execPath, [bin, 'commit', 'ls'], { env, encoding: 'utf8' }), /秘密承诺/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
