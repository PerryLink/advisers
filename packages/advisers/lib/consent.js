/**
 * Local consent records for data-egress surfaces (0.4 Policy subset).
 *
 * File: $ADVISERS_HOME/consent.json (0600, atomic same-directory temp + fsync +
 * rename, directory 0700). Shape:
 *
 *   { version: 1, entries: [ {
 *       surface, dataClass, provider, baseUrl, grantedAt, channel,
 *       revokedAt? } ] }
 *
 * Granularity: one entry per surface + dataClass + provider (+ baseUrl). A
 * changed provider/baseUrl invalidates the old entry (consentStatus reports
 * provider-changed / base-url-changed and granted:false). Revocation keeps the
 * row with revokedAt (the local audit trail), it never re-grants implicitly.
 *
 * This module stores the PRODUCT consent record. It is not a legal agreement,
 * not proof the user understood the consequences, and not tamper-proof: the
 * same user can edit the file. docs/TOS.md §9.3 / docs/PRIVACY.md §4 must list
 * the surfaces before they ship (lead/legal gate).
 *
 * IO contract: reads/writes only the given home (tests use a temp
 * ADVISERS_HOME); no network; no tokens or message bodies are ever written.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { atomicWriteFileSync } from './fs-safe.js'
import { policyError } from './policy/errors.js'
import { DATA_CLASSES } from './policy/surfaces.js'

/** Format version of consent.json. */
export const CONSENT_VERSION = 1
export const CONSENT_FILE = 'consent.json'
export const CONSENT_FILE_MODE = 0o600
export const CONSENT_DIR_MODE = 0o700
/** How the consent was recorded; never inferred. */
export const CONSENT_CHANNELS = Object.freeze(['tty', 'flag', 'env'])
const MAX_ENTRIES = 500
const MAX_TEXT = 200

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !value) return false
  return !Number.isNaN(Date.parse(value))
}

function textField(value, field, { max = MAX_TEXT } = {}) {
  const text = trimmed(value)
  if (!text) throw policyError('POLICY_INVALID_FACTS', 'consent ' + field + ' is required')
  if (text.length > max) throw policyError('POLICY_INVALID_FACTS', 'consent ' + field + ' is longer than ' + max + ' characters')
  return text
}

function normalizeBaseUrl(value) {
  if (value === undefined || value === null || value === '') return null
  const text = trimmed(value)
  if (!text) return null
  if (text.length > 300) throw policyError('POLICY_INVALID_FACTS', 'consent baseUrl is longer than 300 characters')
  return text
}

/** Default Advisers home (same rule as lib/tos: ADVISERS_HOME or ~/.advisers). */
export function defaultHome() {
  return process.env.ADVISERS_HOME || join(homedir(), '.advisers')
}

/** Path of consent.json for a home directory. */
export function consentPath(home = defaultHome()) {
  return join(home, CONSENT_FILE)
}

function normalizeEntry(raw) {
  if (!isPlainObject(raw)) return null
  const surface = trimmed(raw.surface)
  const dataClass = trimmed(raw.dataClass)
  const provider = trimmed(raw.provider)
  if (!surface || surface.length > MAX_TEXT) return null
  if (!DATA_CLASSES.includes(dataClass)) return null
  if (!provider || provider.length > MAX_TEXT) return null
  const baseUrl = raw.baseUrl === undefined || raw.baseUrl === null || raw.baseUrl === '' ? null : trimmed(raw.baseUrl)
  if (baseUrl !== null && (!baseUrl || baseUrl.length > 300)) return null
  const grantedAt = trimmed(raw.grantedAt)
  if (!isIsoDate(grantedAt)) return null
  const channel = trimmed(raw.channel)
  if (!CONSENT_CHANNELS.includes(channel)) return null
  const entry = { surface, dataClass, provider, grantedAt, channel }
  if (baseUrl !== null) entry.baseUrl = baseUrl
  if (raw.revokedAt !== undefined && raw.revokedAt !== null && raw.revokedAt !== '') {
    const revokedAt = trimmed(raw.revokedAt)
    if (!isIsoDate(revokedAt)) return null
    entry.revokedAt = revokedAt
  }
  return entry
}

function compareEntries(left, right) {
  const a = [left.surface, left.dataClass, left.provider, left.baseUrl ?? '', left.grantedAt].join('\u0000')
  const b = [right.surface, right.dataClass, right.provider, right.baseUrl ?? '', right.grantedAt].join('\u0000')
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Validate and canonicalise a parsed consent record.
 * A single malformed entry invalidates the WHOLE file (fail closed): a
 * partially trusted consent file is how a forged entry would slip through.
 *
 * @returns {{version: 1, entries: object[]}|null}
 */
export function validateConsentRecord(record) {
  if (!isPlainObject(record)) return null
  if (record.version !== CONSENT_VERSION) return null
  if (!Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES) return null
  const entries = []
  const seen = new Set()
  for (const raw of record.entries) {
    const entry = normalizeEntry(raw)
    if (!entry) return null
    const key = [entry.surface, entry.dataClass, entry.provider, entry.baseUrl ?? '', entry.grantedAt, entry.revokedAt ?? ''].join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  entries.sort(compareEntries)
  return { version: CONSENT_VERSION, entries }
}

/** Read + validate consent.json; missing/corrupt/unreadable files fail closed (null). */
export function readConsent(home = defaultHome()) {
  let raw
  try {
    const target = consentPath(home)
    if (!existsSync(target)) return null
    raw = readFileSync(target, 'utf8')
  } catch {
    return null
  }
  try {
    return validateConsentRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Alias used by lib/policy/index.js (loadConsent/saveConsent naming). */
export const loadConsent = readConsent

/**
 * Atomically write consent.json (0600, directory 0700). Invalid records are
 * rejected before anything touches the filesystem.
 */
export function writeConsent(home = defaultHome(), record) {
  const clean = validateConsentRecord(record)
  if (!clean) throw policyError('POLICY_INVALID_FACTS', 'refusing to write an invalid consent record')
  const target = consentPath(home)
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true, mode: CONSENT_DIR_MODE })
  try { chmodSync(dir, CONSENT_DIR_MODE) } catch {}
  const text = JSON.stringify(clean, null, 2) + '\n'
  atomicWriteFileSync(target, text, { mode: CONSENT_FILE_MODE })
  try { chmodSync(target, CONSENT_FILE_MODE) } catch {}
  return clean
}

/** Alias used by lib/policy/index.js. */
export const saveConsent = writeConsent

function auditOrRefuse(audit, event) {
  if (typeof audit !== 'function') return false
  let result
  try {
    result = audit(event)
  } catch {
    throw policyError('POLICY_AUDIT_UNAVAILABLE', 'the consent audit could not be written; the consent change was refused')
  }
  if (result && typeof result.then === 'function') {
    throw policyError('POLICY_AUDIT_UNAVAILABLE', 'the consent audit callback must be synchronous; the consent change was refused')
  }
  if (isPlainObject(result) && result.ok === false) {
    throw policyError('POLICY_AUDIT_UNAVAILABLE', 'the consent audit reported failure; the consent change was refused')
  }
  return true
}

function entryKey(entry) {
  return [entry.surface, entry.dataClass, entry.provider, entry.baseUrl ?? ''].join('\u0000')
}

function activeEntries(record, { surface, dataClass } = {}) {
  if (!record) return []
  return record.entries.filter((entry) => {
    if (entry.revokedAt) return false
    if (surface && entry.surface !== surface) return false
    if (dataClass && entry.dataClass !== dataClass) return false
    return true
  })
}

/**
 * Record an explicit consent grant (surface + dataClass + provider + baseUrl).
 *
 * The audit callback runs BEFORE the file write: if it throws or reports
 * {ok:false}, the call fails closed and consent.json is left untouched.
 *
 * @param {string} [home]
 * @param {{surface: string, dataClass: string, provider: string, baseUrl?: string,
 *          channel?: 'tty'|'flag'|'env', now?: Date|string, audit?: Function}} input
 * @returns {{version: number, entry: object, record: object, auditWritten: boolean}}
 */
export function grantConsent(home, input = {}) {
  if (isPlainObject(home) && input && Object.keys(input).length === 0) {
    input = home
    home = defaultHome()
  }
  if (!isPlainObject(input)) throw new TypeError('grantConsent requires an input object')
  const surface = textField(input.surface, 'surface')
  const dataClass = trimmed(input.dataClass)
  if (!DATA_CLASSES.includes(dataClass)) throw policyError('POLICY_INVALID_FACTS', 'consent dataClass must be one of ' + DATA_CLASSES.join(', '))
  const provider = textField(input.provider, 'provider')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const channel = trimmed(input.channel) || 'flag'
  if (!CONSENT_CHANNELS.includes(channel)) throw policyError('POLICY_INVALID_FACTS', 'consent channel must be one of ' + CONSENT_CHANNELS.join(', '))
  const grantedAt = (() => {
    if (input.now === undefined || input.now === null) return new Date().toISOString()
    if (input.now instanceof Date) return input.now.toISOString()
    const text = String(input.now)
    if (Number.isNaN(Date.parse(text))) throw policyError('POLICY_INVALID_FACTS', 'consent now must be an ISO timestamp or Date')
    return new Date(text).toISOString()
  })()
  const entry = { surface, dataClass, provider, grantedAt, channel }
  if (baseUrl !== null) entry.baseUrl = baseUrl
  const event = { action: 'consent.grant', surface, dataClass, provider, baseUrl, channel, at: grantedAt, ok: true }
  const auditWritten = auditOrRefuse(input.audit, event)
  const current = readConsent(home) ?? { version: CONSENT_VERSION, entries: [] }
  const key = entryKey(entry)
  const entries = current.entries.filter((item) => entryKey(item) !== key)
  entries.push(entry)
  const record = writeConsent(home, { version: CONSENT_VERSION, entries })
  return { version: record.version, entry, record, auditWritten }
}

/**
 * Revoke consent. Matching is surface + optional dataClass/provider/baseUrl.
 * Revocation keeps rows (revokedAt) as the local audit trail.
 *
 * @returns {{revoked: number, entries: object[], record: object|null, auditWritten: boolean}}
 */
export function revokeConsent(home, input = {}) {
  if (isPlainObject(home) && input && Object.keys(input).length === 0) {
    input = home
    home = defaultHome()
  }
  if (!isPlainObject(input)) throw new TypeError('revokeConsent requires an input object')
  const surface = textField(input.surface, 'surface')
  const dataClass = trimmed(input.dataClass)
  if (dataClass && !DATA_CLASSES.includes(dataClass)) throw policyError('POLICY_INVALID_FACTS', 'consent dataClass must be one of ' + DATA_CLASSES.join(', '))
  const provider = trimmed(input.provider)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const revokedAt = (() => {
    if (input.now === undefined || input.now === null) return new Date().toISOString()
    if (input.now instanceof Date) return input.now.toISOString()
    const text = String(input.now)
    if (Number.isNaN(Date.parse(text))) throw policyError('POLICY_INVALID_FACTS', 'consent now must be an ISO timestamp or Date')
    return new Date(text).toISOString()
  })()
  const current = readConsent(home)
  if (!current) return { revoked: 0, entries: [], record: null, auditWritten: false }
  const matches = current.entries.filter((entry) => {
    if (entry.revokedAt) return false
    if (entry.surface !== surface) return false
    if (dataClass && entry.dataClass !== dataClass) return false
    if (provider && entry.provider !== provider) return false
    if (baseUrl !== null && (entry.baseUrl ?? null) !== baseUrl) return false
    return true
  })
  if (!matches.length) return { revoked: 0, entries: [], record: current, auditWritten: false }
  const event = { action: 'consent.revoke', surface, dataClass: dataClass || null, provider: provider || null, baseUrl, at: revokedAt, ok: true, revoked: matches.length }
  const auditWritten = auditOrRefuse(input.audit, event)
  const revokedKeys = new Set(matches.map((entry) => entry.grantedAt + '\u0000' + entryKey(entry)))
  const entries = current.entries.map((entry) => {
    const key = entry.grantedAt + '\u0000' + entryKey(entry)
    return revokedKeys.has(key) ? { ...entry, revokedAt } : entry
  })
  const record = writeConsent(home, { version: CONSENT_VERSION, entries })
  const revoked = record.entries.filter((entry) => entry.revokedAt === revokedAt && matches.some((item) => item.surface === entry.surface && item.dataClass === entry.dataClass && item.provider === entry.provider && (item.baseUrl ?? null) === (entry.baseUrl ?? null)))
  return { revoked: revoked.length, entries: revoked, record, auditWritten }
}

/**
 * Consent status for one query. Fail closed: a missing/corrupt file is
 * 'missing'; a mismatch names the changed dimension so the caller can ask for
 * a fresh grant instead of silently reusing consent for a different provider.
 *
 * @param {string} [home]
 * @param {{surface: string, dataClass: string, provider?: string, baseUrl?: string}} query
 * @returns {{granted: boolean, reason: string, entry: object|null, configured: boolean}}
 */
export function consentStatus(home, query = {}) {
  if (isPlainObject(home) && query && Object.keys(query).length === 0) {
    query = home
    home = defaultHome()
  }
  if (!isPlainObject(query)) throw new TypeError('consentStatus requires a query object')
  const surface = trimmed(query.surface)
  const dataClass = trimmed(query.dataClass)
  const provider = trimmed(query.provider)
  const baseUrl = normalizeBaseUrl(query.baseUrl)
  if (!surface || !dataClass) return { granted: false, reason: 'invalid-query', entry: null, configured: false }
  const record = readConsent(home)
  if (!record) return { granted: false, reason: 'missing', entry: null, configured: false }
  const sameClass = record.entries.filter((entry) => entry.surface === surface && entry.dataClass === dataClass)
  const active = sameClass.filter((entry) => !entry.revokedAt)
  if (!sameClass.length) return { granted: false, reason: 'missing', entry: null, configured: true }
  if (!active.length) return { granted: false, reason: 'revoked', entry: sameClass[sameClass.length - 1], configured: true }
  if (provider) {
    const matchingProvider = sameClass.filter((entry) => entry.provider === provider)
    if (!matchingProvider.length) {
      return { granted: false, reason: 'provider-changed', entry: sameClass[sameClass.length - 1], configured: true }
    }
    const activeProvider = matchingProvider.filter((entry) => !entry.revokedAt)
    if (!activeProvider.length) {
      return { granted: false, reason: 'revoked', entry: matchingProvider[matchingProvider.length - 1], configured: true }
    }
    if (baseUrl !== null) {
      const sameBase = activeProvider.filter((entry) => (entry.baseUrl ?? null) === baseUrl)
      if (!sameBase.length) {
        const revokedBase = matchingProvider.some((entry) => entry.revokedAt && (entry.baseUrl ?? null) === baseUrl)
        return {
          granted: false,
          reason: revokedBase ? 'revoked' : 'base-url-changed',
          entry: activeProvider[activeProvider.length - 1],
          configured: true,
        }
      }
      return { granted: true, reason: 'granted', entry: sameBase[sameBase.length - 1], configured: true }
    }
    return { granted: true, reason: 'granted', entry: activeProvider[activeProvider.length - 1], configured: true }
  }
  return { granted: true, reason: 'granted', entry: active[active.length - 1], configured: true }
}

/**
 * Consent fact for evaluate(facts): granted is only true when the stored entry
 * matches the surface + dataClass (+ provider/baseUrl when the caller knows
 * them). The provider recorded in the entry is always carried, because a
 * consent without a named provider cannot satisfy R-P04-05.
 *
 * @returns {{surface: string, dataClass: string, provider: string, baseUrl: string|null,
 *            granted: boolean, reason: string}}
 */
export function consentFacts(home, query = {}) {
  if (isPlainObject(home) && query && Object.keys(query).length === 0) {
    query = home
    home = defaultHome()
  }
  if (!isPlainObject(query)) throw new TypeError('consentFacts requires a query object')
  const status = consentStatus(home, query)
  const entry = status.entry ?? null
  return {
    surface: trimmed(query.surface) || (entry ? entry.surface : ''),
    dataClass: trimmed(query.dataClass) || (entry ? entry.dataClass : ''),
    provider: trimmed(query.provider) || (entry ? entry.provider : ''),
    baseUrl: normalizeBaseUrl(query.baseUrl) ?? (entry ? entry.baseUrl ?? null : null),
    granted: status.granted === true,
    reason: status.reason,
  }
}

/** JSON-ready list of every stored entry with its active/revoked state. */
export function listConsents(home = defaultHome()) {
  const record = readConsent(home)
  if (!record) return []
  return record.entries.map((entry) => ({
    surface: entry.surface,
    dataClass: entry.dataClass,
    provider: entry.provider,
    baseUrl: entry.baseUrl ?? null,
    grantedAt: entry.grantedAt,
    channel: entry.channel,
    revokedAt: entry.revokedAt ?? null,
    active: !entry.revokedAt,
  }))
}
