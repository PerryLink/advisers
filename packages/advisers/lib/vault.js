/**
 * P2: encrypted handoff package.
 *
 * AES-256-GCM with a scrypt-derived key. The passphrase is supplied by the
 * caller (CLI env) and is never written to disk or logged. The envelope is
 * self-describing and safe to store as JSON:
 *   { v:1, alg:'aes-256-gcm', kdf:'scrypt', n:16384, r:8, p:1, salt, iv, tag, data }
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const ENVELOPE_VERSION = 1
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function isVaultEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.v === ENVELOPE_VERSION && value.alg === 'aes-256-gcm')
}

function keyFor(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('passphrase must be at least 8 characters')
  return scryptSync(passphrase, salt, 32, SCRYPT)
}

export function encryptJson(value, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = keyFor(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: ENVELOPE_VERSION, alg: 'aes-256-gcm', kdf: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64'),
  }
}

export function decryptJson(envelope, passphrase) {
  if (!isVaultEnvelope(envelope)) throw new Error('not an Advisers encrypted export')
  let salt, iv, tag, data
  try {
    salt = Buffer.from(envelope.salt, 'base64'); iv = Buffer.from(envelope.iv, 'base64')
    tag = Buffer.from(envelope.tag, 'base64'); data = Buffer.from(envelope.data, 'base64')
  } catch { throw new Error('malformed encrypted export') }
  if (iv.length !== 12 || tag.length !== 16 || salt.length < 8) throw new Error('malformed encrypted export')
  const key = keyFor(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plain
  try { plain = Buffer.concat([decipher.update(data), decipher.final()]) } catch { throw new Error('wrong passphrase or tampered export') }
  return JSON.parse(plain.toString('utf8'))
}
