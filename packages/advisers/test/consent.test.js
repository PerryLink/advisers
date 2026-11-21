/**
 * Consent record (0.4) — $ADVISERS_HOME/consent.json.
 *
 * Every case uses a fresh mkdtemp home; the real ~/.advisers is never read or
 * written. Covers 0600 atomic writes, surface+dataClass+provider granularity,
 * provider/baseUrl change invalidation, revocation, fail-closed corrupt files,
 * and the audit callback (including fail-closed audit errors).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { POLICY_CODES } from '../lib/policy/index.js'
import {
  CONSENT_FILE,
  CONSENT_FILE_MODE,
  CONSENT_VERSION,
  consentFacts,
  consentPath,
  consentStatus,
  defaultHome,
  grantConsent,
  listConsents,
  readConsent,
  revokeConsent,
  validateConsentRecord,
  writeConsent,
} from '../lib/consent.js'

const isPosix = process.platform !== 'win32'
const NOW = new Date('2026-11-21T03:00:00.000Z')

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-consent-'))
  return { root, home: join(root, 'home'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function withHome(fn) {
  const h = makeHome()
  try {
    return fn(h)
  } finally {
    h.cleanup()
  }
}

const MAIL_GRANT = { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', channel: 'flag' }

test('grantConsent writes 0600 consent.json atomically (dir 0700)', () => {
  withHome(({ home }) => {
    const result = grantConsent(home, { ...MAIL_GRANT, now: NOW })
    assert.equal(result.entry.surface, 'mail.extract')
    assert.equal(result.entry.dataClass, 'mail')
    assert.equal(result.entry.provider, 'deepseek')
    assert.equal(result.entry.baseUrl, 'https://api.deepseek.com')
    assert.equal(result.entry.channel, 'flag')
    assert.equal(result.entry.grantedAt, NOW.toISOString())
    assert.equal(result.entry.revokedAt, undefined)

    const file = consentPath(home)
    assert.equal(file, join(home, CONSENT_FILE))
    assert.equal(existsSync(file), true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, CONSENT_VERSION)
    assert.equal(raw.entries.length, 1)
    assert.equal(raw.entries[0].provider, 'deepseek')
    // No temp file survives; the installed file is complete JSON.
    const leftovers = readdirSync(home).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
    if (isPosix) {
      assert.equal(statSync(file).mode & 0o777, CONSENT_FILE_MODE)
      assert.equal(statSync(home).mode & 0o777, 0o700)
    }
  })
})

test('readConsent/validateConsentRecord round-trip and fail closed on a corrupt file', () => {
  withHome(({ home }) => {
    grantConsent(home, { ...MAIL_GRANT, now: NOW })
    const record = readConsent(home)
    assert.equal(record.version, CONSENT_VERSION)
    assert.equal(record.entries.length, 1)
    assert.equal(validateConsentRecord(record).entries.length, 1)
    assert.equal(validateConsentRecord({ version: 2, entries: [] }), null)
    assert.equal(validateConsentRecord(null), null)
    assert.equal(validateConsentRecord({ version: 1, entries: [{ surface: 'mail.extract' }] }), null)

    writeFileSync(consentPath(home), '{not json')
    assert.equal(readConsent(home), null)
    assert.deepEqual(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail' }), { granted: false, reason: 'missing', entry: null, configured: false })

    writeFileSync(consentPath(home), JSON.stringify({ version: 1, entries: [{ surface: 'mail.extract', dataClass: 'mail' }] }))
    assert.equal(readConsent(home), null, 'a partially valid record is not trusted')
  })
})

test('consent is scoped to surface + dataClass + provider (+baseUrl)', () => {
  withHome(({ home }) => {
    grantConsent(home, { ...MAIL_GRANT, now: NOW })
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail' }).granted, true)
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek' }).granted, true)
    assert.equal(
      consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }).granted,
      true,
    )
    assert.equal(consentStatus(home, { surface: 'kb.ask', dataClass: 'mail', provider: 'deepseek' }).granted, false)
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'kb', provider: 'deepseek' }).granted, false)

    const changedProvider = consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'other' })
    assert.equal(changedProvider.granted, false)
    assert.equal(changedProvider.reason, 'provider-changed')

    const changedBase = consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek', baseUrl: 'https://other.example' })
    assert.equal(changedBase.granted, false)
    assert.equal(changedBase.reason, 'base-url-changed')

    const facts = consentFacts(home, { surface: 'mail.extract', dataClass: 'mail' })
    assert.equal(facts.granted, true)
    assert.equal(facts.provider, 'deepseek', 'the recorded provider is carried into policy facts')
    assert.equal(facts.baseUrl, 'https://api.deepseek.com')
  })
})

test('grants for different providers coexist; re-granting a key updates instead of duplicating', () => {
  withHome(({ home }) => {
    grantConsent(home, { ...MAIL_GRANT, now: NOW })
    grantConsent(home, { ...MAIL_GRANT, provider: 'other', now: NOW })
    assert.equal(readConsent(home).entries.length, 2)
    grantConsent(home, { ...MAIL_GRANT, channel: 'tty', now: new Date('2026-11-21T04:00:00.000Z') })
    const entries = readConsent(home).entries
    assert.equal(entries.length, 2, 'same key must not duplicate')
    const deepseek = entries.find((entry) => entry.provider === 'deepseek')
    assert.equal(deepseek.channel, 'tty')
    assert.equal(deepseek.grantedAt, '2026-11-21T04:00:00.000Z')
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'other' }).granted, true)
  })
})

test('revokeConsent marks matching entries only and keeps the audit trail', () => {
  withHome(({ home }) => {
    grantConsent(home, { ...MAIL_GRANT, now: NOW })
    grantConsent(home, { ...MAIL_GRANT, provider: 'other', now: NOW })
    const revoked = revokeConsent(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek', now: new Date('2026-11-21T05:00:00.000Z') })
    assert.equal(revoked.revoked, 1)
    assert.equal(revoked.entries[0].revokedAt, '2026-11-21T05:00:00.000Z')
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek' }).reason, 'revoked')
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'other' }).granted, true)
    const active = listConsents(home).filter((entry) => entry.active)
    assert.equal(active.length, 1)
    assert.equal(active[0].provider, 'other')
    // Re-granting after revocation creates one active entry again.
    grantConsent(home, { ...MAIL_GRANT, now: new Date('2026-11-21T06:00:00.000Z') })
    assert.equal(consentStatus(home, { surface: 'mail.extract', dataClass: 'mail', provider: 'deepseek' }).granted, true)
    const stored = readConsent(home).entries.filter((entry) => entry.provider === 'deepseek')
    assert.equal(stored.length, 1)
    assert.equal(stored[0].revokedAt, undefined)
  })
})

test('writeConsent rejects invalid records and never touches the installed file', () => {
  withHome(({ home }) => {
    grantConsent(home, { ...MAIL_GRANT, now: NOW })
    const before = readFileSync(consentPath(home), 'utf8')
    assert.throws(
      () => writeConsent(home, { version: 1, entries: [{ surface: '', dataClass: 'mail', provider: 'x', grantedAt: NOW.toISOString(), channel: 'flag' }] }),
      (error) => error.code === POLICY_CODES.POLICY_INVALID_FACTS.code,
    )
    assert.equal(readFileSync(consentPath(home), 'utf8'), before)
  })
})

test('grant/revoke call the audit callback; a failing audit refuses the change', () => {
  withHome(({ home }) => {
    const events = []
    grantConsent(home, { ...MAIL_GRANT, now: NOW, audit: (event) => events.push(event) })
    assert.equal(events.length, 1)
    assert.equal(events[0].action, 'consent.grant')
    assert.equal(events[0].surface, 'mail.extract')
    assert.equal(events[0].provider, 'deepseek')
    revokeConsent(home, { surface: 'mail.extract', dataClass: 'mail', now: NOW, audit: (event) => events.push(event) })
    assert.equal(events.length, 2)
    assert.equal(events[1].action, 'consent.revoke')
    assert.equal(events[1].revoked, 1)
  })
  withHome(({ home }) => {
    assert.throws(
      () => grantConsent(home, { ...MAIL_GRANT, now: NOW, audit: () => { throw new Error('audit db locked') } }),
      (error) => error.code === POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code,
    )
    assert.equal(existsSync(consentPath(home)), false, 'a refused grant must not write consent')
    grantConsent(home, { ...MAIL_GRANT, now: NOW })
    const before = readFileSync(consentPath(home), 'utf8')
    assert.throws(
      () => revokeConsent(home, { surface: 'mail.extract', now: NOW, audit: async () => {} }),
      (error) => error.code === POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code,
    )
    assert.equal(readFileSync(consentPath(home), 'utf8'), before)
  })
})

test('default home follows ADVISERS_HOME (tests never touch the real home)', () => {
  const previous = process.env.ADVISERS_HOME
  const h = makeHome()
  try {
    process.env.ADVISERS_HOME = h.home
    assert.equal(defaultHome(), h.home)
    assert.equal(consentPath(), join(h.home, CONSENT_FILE))
    grantConsent({ ...MAIL_GRANT, now: NOW })
    assert.equal(existsSync(join(h.home, CONSENT_FILE)), true)
    assert.equal(consentStatus({ surface: 'mail.extract', dataClass: 'mail' }).granted, true)
  } finally {
    if (previous === undefined) delete process.env.ADVISERS_HOME
    else process.env.ADVISERS_HOME = previous
    h.cleanup()
  }
})
