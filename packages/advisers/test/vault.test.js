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
