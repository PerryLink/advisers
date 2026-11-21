/**
 * Pure policy engine (0.4 subset): evaluate(facts) -> decision.
 *
 * Invariants:
 * - no I/O, no network, no wall-clock reads, no user content: the decision is a
 *   deterministic function of the facts only (same facts -> same bytes);
 * - deny > confirm > allow; unknown/unregistered paths fail closed;
 * - reasons never echo quotes, titles or absolute paths: only classes/labels;
 * - effectDigest binds the decision to the exact effect metadata, so a caller
 *   cannot get an allow for one recipient/secret level and execute another.
 *
 * The 0.4 subset implements R-P04-01..10 (see POLICY_RULES). Its real threat
 * model is "a new code path forgot to call the gate", not a same-user process
 * that can read HOME / rewrite the source (docs/SECURITY.md #8).
 */
import { createHash } from 'node:crypto'

import { POLICY_CODES, policyCodeFor } from './errors.js'
import {
  CLEARANCE_ACTIONS,
  DATA_CLASSES,
  EGRESS_ACTIONS,
  PATH_ACTIONS,
  POLICY_ACTIONS,
  POLICY_VERSION,
  RULESET_VERSION,
  SAFETY_REQUIRED_ACTIONS,
  SIDE_EFFECT_ACTIONS,
  TOS_REQUIRED_ACTIONS,
  getSurface,
  normalizeSurface,
  surfaceSupportsAction,
} from './surfaces.js'

/** Rule catalogue (stable ids; docs and tests refer to them). */
export const POLICY_RULES = Object.freeze([
  Object.freeze({ id: 'R-P04-00', title: 'facts must be well formed (pre-rule, fail closed)' }),
  Object.freeze({ id: 'R-P04-01', title: 'registered surface + action only; not-wired surfaces disabled' }),
  Object.freeze({ id: 'R-P04-02', title: 'current TOS accepted (version/hash match)' }),
  Object.freeze({ id: 'R-P04-03', title: 'egress of a protected matter is blocked' }),
  Object.freeze({ id: 'R-P04-04', title: 'read/export respects per-record clearance' }),
  Object.freeze({ id: 'R-P04-05', title: 'model egress of mail/KB content requires consent' }),
  Object.freeze({ id: 'R-P04-06', title: 'tainted content driving fs/send/exec needs interactive confirmation' }),
  Object.freeze({ id: 'R-P04-07', title: 'side effects require a writable intent/result audit' }),
  Object.freeze({ id: 'R-P04-08', title: 'protected/persistence paths and workspace escapes are blocked' }),
  Object.freeze({ id: 'R-P04-09', title: 'content safety: blocked content denied; missing verdict fails closed' }),
  Object.freeze({ id: 'R-P04-10', title: 'default allow with obligations' }),
])

/** Keys that make up the effect digest (anything else is ignored on purpose). */
export const EFFECT_DIGEST_FIELDS = Object.freeze([
  'surface', 'action', 'path', 'recipient', 'subject', 'provider', 'dataClass', 'recordKind', 'recordSecrecy',
])

const TRUSTED_PATH_KINDS = Object.freeze(['workspace', 'normal', 'allowed'])
const DENIED_PATH_KINDS = Object.freeze(['sensitive', 'persistence', 'outside'])
const PATH_KIND_ALIASES = Object.freeze({
  SENSITIVE_PATH: 'sensitive',
  PERSISTENCE_WRITE: 'persistence',
  OUTSIDE_WORKSPACE: 'outside',
  SYMLINK_ESCAPE: 'outside',
  WORKSPACE_MISMATCH: 'outside',
  sensitive: 'sensitive',
  persistence: 'persistence',
  outside: 'outside',
  workspace: 'workspace',
  normal: 'normal',
  allowed: 'allowed',
})

const CONSENT_DATA_CLASSES = Object.freeze(['mail', 'kb'])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Deterministic JSON: sorted keys at every depth, undefined dropped. */
export function canonicalJson(value) {
  const normalize = (input) => {
    if (input === undefined) return null
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input).sort()) {
        if (input[key] === undefined) continue
        out[key] = normalize(input[key])
      }
      return out
    }
    if (typeof input === 'number' && !Number.isFinite(input)) return null
    return input
  }
  return JSON.stringify(normalize(value))
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function effectField(effect, key) {
  if (!isPlainObject(effect)) return undefined
  if (key === 'path') {
    const path = effect.path
    if (typeof path === 'string') return path
    if (isPlainObject(path)) return typeof path.kind === 'string' ? path.kind : undefined
    return undefined
  }
  if (key === 'recordKind' || key === 'recordSecrecy') {
    const record = isPlainObject(effect.record) ? effect.record : null
    if (record) return record[key === 'recordKind' ? 'kind' : 'secrecy']
    return effect[key]
  }
  return effect[key]
}

/**
 * SHA-256 over the canonical effect metadata: surface, action, path class,
 * recipient, subject, provider, dataClass, record kind/secrecy. Callers pass
 * the same object to consumeDecision(); unknown keys are ignored.
 */
export function effectDigestOf(effect) {
  const payload = {}
  for (const key of EFFECT_DIGEST_FIELDS) {
    const value = effectField(effect, key)
    if (value === undefined || value === null || value === '') continue
    payload[key] = value
  }
  return 'sha256:' + sha256Hex(canonicalJson(payload))
}

function normalizePathFact(raw) {
  if (raw === undefined || raw === null || raw === '') return { path: null }
  let kind = ''
  let legacyCode = ''
  if (typeof raw === 'string') {
    kind = raw
  } else if (isPlainObject(raw)) {
    kind = typeof raw.kind === 'string' ? raw.kind : ''
    legacyCode = trimmed(raw.code ?? raw.legacyCode)
    if (!kind && legacyCode) kind = legacyCode
  } else {
    return { error: 'path must be a classification string or {kind}' }
  }
  const canonical = PATH_KIND_ALIASES[kind] ?? PATH_KIND_ALIASES[trimmed(kind)] ?? null
  if (!canonical) return { error: 'unknown path classification "' + trimmed(kind).slice(0, 40) + '"' }
  const path = { kind: canonical }
  if (legacyCode) path.code = legacyCode.slice(0, 40)
  return { path }
}

function normalizeRecordFact(raw) {
  if (raw === undefined || raw === null) return { record: null }
  if (!isPlainObject(raw)) return { error: 'record must be an object or null' }
  let secrecy = 0
  if (raw.secrecy !== undefined && raw.secrecy !== null) {
    const value = Number(raw.secrecy)
    secrecy = Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  const kind = trimmed(raw.kind) || 'record'
  return { record: { kind: kind.slice(0, 40), secrecy } }
}

function normalizeTosFact(raw) {
  if (raw === undefined || raw === null) return { tos: null }
  if (!isPlainObject(raw)) return { error: 'tos must be an object or null' }
  const tos = {
    accepted: raw.accepted === true,
    version: trimmed(raw.version),
    currentVersion: trimmed(raw.currentVersion),
    hashOk: raw.hashOk === undefined || raw.hashOk === null ? null : raw.hashOk === true,
  }
  return { tos }
}

function normalizeConsentFact(raw) {
  if (raw === undefined || raw === null) return { consent: null }
  if (!isPlainObject(raw)) return { error: 'consent must be an object or null' }
  return {
    consent: {
      dataClass: trimmed(raw.dataClass),
      provider: trimmed(raw.provider),
      baseUrl: trimmed(raw.baseUrl),
      granted: raw.granted === true,
      surface: trimmed(raw.surface),
      revoked: raw.revokedAt !== undefined && raw.revokedAt !== null && trimmed(raw.revokedAt) !== '',
    },
  }
}

function normalizeSafetyFact(raw) {
  if (raw === undefined || raw === null) return { safety: null }
  if (isPlainObject(raw)) {
    const action = trimmed(raw.action).toLowerCase()
    if (!action) return { error: 'safety.action is required' }
    return { safety: { action } }
  }
  if (typeof raw === 'string') return { safety: { action: raw.trim().toLowerCase() } }
  return { error: 'safety must be an object or null' }
}

function normalizeAuditFact(raw) {
  if (raw === undefined || raw === null) return { audit: null }
  if (!isPlainObject(raw)) return { error: 'audit must be an object or null' }
  return { audit: { available: raw.available === true } }
}

function normalizeTrustFact(raw) {
  if (raw === undefined || raw === null) return { trust: null }
  if (!isPlainObject(raw)) return { error: 'trust must be an object or null' }
  const kinds = Array.isArray(raw.sourceKinds) ? raw.sourceKinds.filter((item) => typeof item === 'string').slice(0, 20) : []
  return { trust: { tainted: raw.tainted === true, sourceKinds: kinds } }
}

function normalizeDataClass(raw, surfaceRow) {
  const explicit = trimmed(raw)
  if (explicit) return DATA_CLASSES.includes(explicit) ? explicit : { error: 'unknown dataClass' }
  return surfaceRow ? surfaceRow.dataClass : 'unknown'
}

/**
 * Validate/normalise facts. Structural problems are returned as errors (the
 * caller converts them into a fail-closed deny); they are never guessed away.
 */
export function canonicalFacts(input) {
  const errors = []
  if (!isPlainObject(input)) return { ok: false, errors: ['facts must be an object'], facts: null }
  if (input.v !== undefined && input.v !== 1) errors.push('facts.v must be 1')
  const surfaceRaw = input.surface
  if (typeof surfaceRaw !== 'string' || !surfaceRaw.trim()) errors.push('surface is required')
  const surface = normalizeSurface(surfaceRaw)
  const action = trimmed(input.action)
  if (!action) errors.push('action is required')
  const surfaceRow = surface ? getSurface(surface) : null
  const dataClass = normalizeDataClass(input.dataClass, surfaceRow)
  if (isPlainObject(dataClass)) errors.push(dataClass.error)
  const record = normalizeRecordFact(input.record)
  if (record.error) errors.push(record.error)
  const tos = normalizeTosFact(input.tos)
  if (tos.error) errors.push(tos.error)
  const consent = normalizeConsentFact(input.consent)
  if (consent.error) errors.push(consent.error)
  const safety = normalizeSafetyFact(input.safety)
  if (safety.error) errors.push(safety.error)
  const audit = normalizeAuditFact(input.audit)
  if (audit.error) errors.push(audit.error)
  const trust = normalizeTrustFact(input.trust)
  if (trust.error) errors.push(trust.error)
  const path = normalizePathFact(input.path)
  if (path.error) errors.push(path.error)
  let clearance = 0
  if (input.clearance !== undefined && input.clearance !== null) {
    clearance = Number(input.clearance)
    if (!Number.isFinite(clearance) || clearance < 0) errors.push('clearance must be a non-negative number')
  }
  if (errors.length) return { ok: false, errors, facts: null }
  return {
    ok: true,
    errors: [],
    facts: {
      v: 1,
      surface: surface || trimmed(surfaceRaw).toLowerCase().slice(0, 60),
      surfaceRegistered: Boolean(surface),
      action: action.slice(0, 60),
      actor: trimmed(input.actor) || 'cli',
      interactive: input.interactive === true,
      confirmed: input.confirmed === true,
      dataClass: isPlainObject(dataClass) ? 'unknown' : dataClass,
      record: record.record,
      clearance,
      path: path.path,
      safety: safety.safety,
      tos: tos.tos,
      consent: consent.consent,
      audit: audit.audit,
      trust: trust.trust,
    },
  }
}

function hit(ruleId, severity, policyCode, reason, extra) {
  const entry = POLICY_CODES[policyCode]
  const out = {
    ruleId,
    severity,
    policyCode,
    code: entry ? entry.code : policyCodeFor(policyCode),
    reason,
  }
  if (extra && typeof extra === 'object') Object.assign(out, extra)
  return out
}

const OBLIGATION_ORDER = Object.freeze(['audit.intent', 'audit.result', 'consent.record', 'confirm'])

function collectHits(facts) {
  const hits = []
  const row = facts.surfaceRegistered ? getSurface(facts.surface) : null

  // R-P04-01: registered surface + declared action; not-wired surfaces stay off.
  if (!row) {
    hits.push(hit('R-P04-01', 'deny', 'POLICY_UNKNOWN_SURFACE', 'surface is not registered in the policy surface registry'))
  } else if (!surfaceSupportsAction(row.surface, facts.action)) {
    hits.push(hit('R-P04-01', 'deny', 'POLICY_UNKNOWN_SURFACE', 'action is not declared for surface ' + row.surface))
  } else if (row.gate === 'not-wired') {
    hits.push(hit('R-P04-01', 'deny', 'POLICY_SURFACE_NOT_ENABLED', 'surface ' + row.surface + ' is registered but not wired/enabled in this release'))
  }

  // R-P04-02: TOS acceptance facts (E_TOS_REQUIRED keeps exit 3).
  if (TOS_REQUIRED_ACTIONS.includes(facts.action)) {
    const tos = facts.tos
    if (!tos || tos.accepted !== true) {
      hits.push(hit('R-P04-02', 'deny', 'POLICY_TOS_REQUIRED', 'the current terms of service have not been accepted'))
    } else if (tos.version && tos.currentVersion && tos.version !== tos.currentVersion) {
      hits.push(hit('R-P04-02', 'deny', 'POLICY_TOS_REQUIRED', 'the accepted terms version does not match the current version'))
    } else if (tos.hashOk === false) {
      hits.push(hit('R-P04-02', 'deny', 'POLICY_TOS_REQUIRED', 'the accepted terms text hash does not match the packaged text'))
    }
  }

  // R-P04-03: no egress from a protected matter (per-item secrecy).
  if (EGRESS_ACTIONS.includes(facts.action) && facts.record && facts.record.secrecy > 0) {
    hits.push(hit('R-P04-03', 'deny', 'POLICY_SECRECY_BLOCKED', 'egress of a record from a protected matter is blocked'))
  }

  // R-P04-04: read/export clearance.
  if (CLEARANCE_ACTIONS.includes(facts.action) && facts.record && facts.record.secrecy > facts.clearance) {
    hits.push(hit('R-P04-04', 'deny', 'POLICY_SECRECY_BLOCKED', 'record secrecy is above the requested clearance'))
  }

  // R-P04-05: model egress of mail/KB content requires a consent record.
  if (facts.action === 'model-egress' && CONSENT_DATA_CLASSES.includes(facts.dataClass)) {
    const consent = facts.consent
    if (!consent || consent.granted !== true || consent.revoked) {
      hits.push(hit('R-P04-05', 'deny', 'POLICY_CONSENT_REQUIRED', 'model egress of ' + facts.dataClass + ' content requires an explicit consent record'))
    } else if (consent.dataClass && consent.dataClass !== facts.dataClass) {
      hits.push(hit('R-P04-05', 'deny', 'POLICY_CONSENT_REQUIRED', 'consent data class does not match the content being sent'))
    } else if (!consent.provider) {
      hits.push(hit('R-P04-05', 'deny', 'POLICY_CONSENT_REQUIRED', 'consent record does not name the model provider'))
    } else if (consent.surface && row && consent.surface !== row.surface) {
      hits.push(hit('R-P04-05', 'deny', 'POLICY_CONSENT_REQUIRED', 'consent was granted for a different surface'))
    }
  }

  // R-P04-06: tainted content must not drive fs/send/exec without confirmation.
  if (facts.trust && facts.trust.tainted && ['write-fs', 'send', 'exec'].includes(facts.action)) {
    if (!facts.interactive) {
      hits.push(hit('R-P04-06', 'deny', 'POLICY_CONFIRMATION_UNAVAILABLE', 'untrusted content would drive a side effect and no interactive confirmation is available'))
    } else if (!facts.confirmed) {
      hits.push(hit('R-P04-06', 'confirm', 'POLICY_CONFIRMATION_UNAVAILABLE', 'untrusted content would drive a side effect; interactive confirmation is required'))
    }
  }

  // R-P04-07: side effects need a writable audit channel (fail closed).
  if (SIDE_EFFECT_ACTIONS.includes(facts.action) && !(facts.audit && facts.audit.available === true)) {
    hits.push(hit('R-P04-07', 'deny', 'POLICY_AUDIT_UNAVAILABLE', 'the intent/result audit is unavailable; refusing the side effect'))
  }

  // R-P04-08: path classification.
  if (facts.path) {
    if (facts.path.kind === 'sensitive' || facts.path.kind === 'persistence') {
      hits.push(hit('R-P04-08', 'deny', 'POLICY_PROTECTED_PATH', 'the target path is a protected or persistence location', { legacyCode: facts.path.code || undefined }))
    } else if (facts.path.kind === 'outside') {
      hits.push(hit('R-P04-08', 'deny', 'POLICY_WORKSPACE_ESCAPE', 'the target path escapes the workspace boundary', { legacyCode: facts.path.code || undefined }))
    }
  } else if (PATH_ACTIONS.includes(facts.action)) {
    hits.push(hit('R-P04-08', 'deny', 'POLICY_INVALID_FACTS', 'this action requires a path classification fact'))
  }

  // R-P04-09: content safety.
  if (facts.safety && (facts.safety.action === 'block' || facts.safety.action === 'blocked')) {
    hits.push(hit('R-P04-09', 'deny', 'POLICY_CONTENT_SAFETY_BLOCKED', 'the content safety classifier blocked the content'))
  } else if (SAFETY_REQUIRED_ACTIONS.includes(facts.action) && !facts.safety) {
    hits.push(hit('R-P04-09', 'deny', 'POLICY_SAFETY_REQUIRED', 'a content-safety verdict is required before this action but was not supplied'))
  } else if (facts.safety && facts.safety.action !== 'allow') {
    hits.push(hit('R-P04-09', 'deny', 'POLICY_SAFETY_REQUIRED', 'the content-safety verdict is not a recognised allow'))
  }

  return hits
}

function obligationsFor(facts, decision) {
  const obligations = new Set()
  if (decision === 'confirm') obligations.add('confirm')
  if (decision === 'allow') {
    if (SIDE_EFFECT_ACTIONS.includes(facts.action)) {
      obligations.add('audit.intent')
      obligations.add('audit.result')
    }
    if (facts.action === 'model-egress' && CONSENT_DATA_CLASSES.includes(facts.dataClass)) obligations.add('consent.record')
  }
  return OBLIGATION_ORDER.filter((item) => obligations.has(item))
}

function refused(facts, decision, hits, extra) {
  const ordered = [...hits].sort((a, b) => a.ruleId.localeCompare(b.ruleId))
  const decisive =
    decision === 'deny'
      ? ordered.find((item) => item.severity === 'deny')
      : decision === 'confirm'
        ? ordered.find((item) => item.severity === 'confirm')
        : null
  return {
    v: 1,
    policyVersion: POLICY_VERSION,
    rulesetVersion: RULESET_VERSION,
    surface: facts.surface,
    action: facts.action,
    dataClass: facts.dataClass,
    decision,
    code: decisive ? decisive.code : null,
    policyCode: decisive ? decisive.policyCode : null,
    ruleIds: ordered.map((item) => item.ruleId),
    obligations: obligationsFor(facts, decision),
    reason: decisive ? decisive.reason : 'allowed by policy',
    effectDigest: effectDigestOf({
      surface: facts.surface,
      action: facts.action,
      path: facts.path,
      dataClass: facts.dataClass,
      record: facts.record,
    }),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
}

/**
 * Evaluate policy facts. Pure and total: malformed facts produce a deny, never
 * an exception. The result is JSON-ready and contains no user content.
 *
 * @param {object} facts see lib/policy/README-equivalent header docs in docs/ARCHITECTURE.md
 * @returns {{v: 1, decision: 'allow'|'confirm'|'deny', code: string|null,
 *            policyCode: string|null, ruleIds: string[], obligations: string[],
 *            reason: string, effectDigest: string, surface: string, action: string,
 *            dataClass: string, policyVersion: number, rulesetVersion: string}}
 */
export function evaluate(facts) {
  const normalized = canonicalFacts(facts)
  if (!normalized.ok) {
    const surface = isPlainObject(facts) && typeof facts.surface === 'string' ? facts.surface.slice(0, 60) : 'unknown'
    const action = isPlainObject(facts) && typeof facts.action === 'string' ? facts.action.slice(0, 60) : 'unknown'
    return {
      v: 1,
      policyVersion: POLICY_VERSION,
      rulesetVersion: RULESET_VERSION,
      surface,
      action,
      dataClass: 'unknown',
      decision: 'deny',
      code: policyCodeFor('POLICY_INVALID_FACTS'),
      policyCode: 'POLICY_INVALID_FACTS',
      ruleIds: ['R-P04-00'],
      obligations: [],
      reason: 'policy facts are malformed: ' + normalized.errors.slice(0, 3).join('; '),
      effectDigest: effectDigestOf({ surface, action }),
    }
  }
  const hits = collectHits(normalized.facts)
  const denied = hits.find((item) => item.severity === 'deny')
  if (denied) return refused(normalized.facts, 'deny', hits)
  const needsConfirm = hits.find((item) => item.severity === 'confirm')
  if (needsConfirm) return refused(normalized.facts, 'confirm', hits)
  const allowHit = hit('R-P04-10', 'allow', null, 'allowed by policy')
  return refused(normalized.facts, 'allow', [allowHit])
}
