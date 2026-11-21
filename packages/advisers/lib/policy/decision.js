/**
 * Decision tokens (0.4 grant-lite) + intent/result audit orchestration.
 *
 * authorize(action, facts) runs evaluate(); on allow it issues a one-shot token
 * bound to an effectDigest (surface/action/path/recipient/subject/provider/
 * dataClass/record kind+secrecy), writes an audit intent row, and returns the
 * token. runWithDecision(token, effect, fn) consumes the token (allow + digest
 * match + unused + unexpired), executes fn and writes the audit result row.
 *
 * Threat model: this catches "a code path forgot to call the gate" and "a
 * decision for A is reused to execute B". It does NOT defend against a
 * same-user process that can rewrite the source or read process memory;
 * docs/SECURITY.md #8 stays the honest statement. The token is in-process only
 * (a Map); 0.5 may add HMAC/TTL persistence. Decision tokens are not secrets.
 */
import { randomUUID } from 'node:crypto'

import { POLICY_CODES, PolicyError, policyError } from './errors.js'
import { EFFECT_DIGEST_FIELDS, canonicalJson, effectDigestOf, evaluate } from './rules.js'

/** Default token lifetime (milliseconds). */
export const DECISION_TOKEN_TTL_MS = 60_000

const tokens = new Map()

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nowMs(now) {
  if (now === undefined || now === null) return Date.now()
  if (now instanceof Date) return now.getTime()
  const value = typeof now === 'number' ? now : Date.parse(String(now))
  if (!Number.isFinite(value)) throw new TypeError('authorize/consumeDecision now must be a Date, epoch ms or ISO string')
  return value
}

function isoAt(ms) {
  return new Date(ms).toISOString()
}

/** JSON-ready decision metadata without the token (safe to print/audit). */
export function decisionView(decision) {
  if (!isPlainObject(decision)) return null
  return {
    surface: decision.surface,
    action: decision.action,
    dataClass: decision.dataClass,
    decision: decision.decision,
    code: decision.code ?? null,
    policyCode: decision.policyCode ?? null,
    ruleIds: Array.isArray(decision.ruleIds) ? [...decision.ruleIds] : [],
    obligations: Array.isArray(decision.obligations) ? [...decision.obligations] : [],
    reason: decision.reason,
    effectDigest: decision.effectDigest,
  }
}

function auditEvent(input) {
  const event = {
    at: input.at,
    actor: input.actor || 'local',
    surface: input.surface,
    action: input.action,
    policyAction: input.policyAction,
    phase: input.phase,
    decision: input.decision,
    allowed: input.decision === 'allow',
  }
  for (const key of ['code', 'policyCode', 'reason', 'decisionId', 'effectDigest']) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') event[key] = input[key]
  }
  if (Array.isArray(input.ruleIds) && input.ruleIds.length) event.ruleIds = [...input.ruleIds]
  if (input.ok !== undefined) event.ok = input.ok === true
  return event
}

/**
 * Write one audit row through a caller-supplied synchronous callback.
 * Returns true on success; a throw or an explicit {ok:false} is a failure
 * (fail closed). The callback never receives content: no quotes, paths,
 * recipients or titles, only the metadata above.
 */
function writeAudit(audit, event) {
  if (typeof audit !== 'function') return false
  let result
  try {
    result = audit(event)
  } catch {
    return false
  }
  if (result && typeof result.then === 'function') return false
  if (isPlainObject(result) && result.ok === false) return false
  return true
}

function tokenRecordOf(token) {
  if (!isPlainObject(token)) return null
  const decisionId = typeof token.decisionId === 'string' ? token.decisionId : ''
  const effectDigest = typeof token.effectDigest === 'string' ? token.effectDigest : ''
  if (!decisionId || !effectDigest) return null
  return {
    decisionId,
    effectDigest,
    surface: typeof token.surface === 'string' ? token.surface : '',
    action: typeof token.action === 'string' ? token.action : '',
    expiresAt: typeof token.expiresAt === 'string' ? token.expiresAt : '',
  }
}

/**
 * Authorize one action for one set of facts.
 *
 * - deny/confirm: returns the evaluate() result plus {authorized:false,
 *   decisionId:null, token:null}; a deny/confirm audit row is attempted when a
 *   callback is supplied but its failure cannot change the refusal;
 * - allow: writes the intent audit row before returning. If the action has the
 *   audit.intent obligation and the callback is missing/throws, the call is
 *   refused with E_POLICY_AUDIT_UNAVAILABLE and no token is issued.
 *
 * @param {string} action canonical policy action
 * @param {object} facts see lib/policy/rules.js evaluate()
 * @param {{now?: Date|number|string, ttlMs?: number, audit?: Function}} [options]
 * @returns {object} decision + {authorized, decisionId, token, expiresAt, auditWritten}
 */
export function authorize(action, facts, options = {}) {
  if (typeof action !== 'string' || !action.trim()) throw new TypeError('authorize(action, facts) requires a non-empty action')
  if (!isPlainObject(facts)) throw new TypeError('authorize(action, facts) requires a facts object')
  if (!isPlainObject(options)) throw new TypeError('authorize options must be an object')
  const at = nowMs(options.now)
  const ttl = options.ttlMs === undefined || options.ttlMs === null ? DECISION_TOKEN_TTL_MS : Number(options.ttlMs)
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError('authorize ttlMs must be a positive number of milliseconds')
  const audit = options.audit
  const decision = evaluate({ ...facts, action })
  const base = { ...decision, authorized: false, decisionId: null, token: null, expiresAt: null, auditWritten: false }

  if (decision.decision !== 'allow') {
    const wrote = writeAudit(
      audit,
      auditEvent({
        at: isoAt(at),
        actor: facts.actor,
        surface: decision.surface,
        action: decision.action,
        policyAction: action,
        phase: 'decision',
        decision: decision.decision,
        code: decision.code,
        policyCode: decision.policyCode,
        reason: decision.reason,
        ruleIds: decision.ruleIds,
      }),
    )
    return { ...base, auditWritten: wrote }
  }

  const decisionId = 'dec_' + randomUUID()
  const expiresAt = isoAt(at + ttl)
  const token = { decisionId, effectDigest: decision.effectDigest, surface: decision.surface, action: decision.action, expiresAt }
  const requiresIntent = Array.isArray(decision.obligations) && decision.obligations.includes('audit.intent')
  if (requiresIntent) {
    const wrote = writeAudit(
      audit,
      auditEvent({
        at: isoAt(at),
        actor: facts.actor,
        surface: decision.surface,
        action: decision.action,
        policyAction: action,
        phase: 'intent',
        decision: 'allow',
        decisionId,
        effectDigest: decision.effectDigest,
        ruleIds: decision.ruleIds,
      }),
    )
    if (!wrote) {
      return {
        ...base,
        decision: 'deny',
        code: POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code,
        policyCode: 'POLICY_AUDIT_UNAVAILABLE',
        ruleIds: [...decision.ruleIds, 'R-P04-07'],
        obligations: [],
        reason: 'the intent audit could not be written; refusing the side effect',
      }
    }
  }
  tokens.set(decisionId, {
    decisionId,
    effectDigest: decision.effectDigest,
    surface: decision.surface,
    action: decision.action,
    expiresAt: at + ttl,
    used: false,
    requiresAudit: requiresIntent,
    createdAt: at,
  })
  return { ...base, authorized: true, decisionId, token, expiresAt, auditWritten: requiresIntent }
}

function assertToken(token) {
  const record = tokenRecordOf(token)
  if (!record) throw policyError('POLICY_TOKEN_INVALID', 'the decision token is malformed')
  const stored = tokens.get(record.decisionId)
  if (!stored) throw policyError('POLICY_TOKEN_UNKNOWN', 'the decision token was not issued by this process')
  if (stored.used) throw policyError('POLICY_TOKEN_REPLAY', 'the decision token was already consumed')
  if (record.effectDigest !== stored.effectDigest || record.surface !== stored.surface || record.action !== stored.action) {
    throw policyError('POLICY_TOKEN_INVALID', 'the decision token fields were modified after issue')
  }
  return stored
}

/**
 * Consume a one-shot decision token for the effect that is about to run.
 * Throws PolicyError (E_POLICY_TOKEN_*) when the token is invalid, expired,
 * already used, tampered with, or when the effect does not match the digest.
 *
 * @param {object} token token returned by authorize()
 * @param {object} effect same effect metadata that was authorized
 * @param {{now?: Date|number|string}} [options]
 * @returns {{decisionId: string, effectDigest: string, surface: string, action: string}}
 */
export function consumeDecision(token, effect, options = {}) {
  const at = nowMs(options.now)
  const stored = assertToken(token)
  if (at > stored.expiresAt) throw policyError('POLICY_TOKEN_EXPIRED', 'the decision token expired before the effect was executed')
  const digest = effectDigestOf(effect)
  if (digest !== stored.effectDigest) {
    throw policyError('POLICY_TOKEN_EFFECT_MISMATCH', 'the effect does not match the effect digest the decision was issued for')
  }
  stored.used = true
  return {
    decisionId: stored.decisionId,
    effectDigest: stored.effectDigest,
    surface: stored.surface,
    action: stored.action,
    auditRequired: stored.requiresAudit === true,
  }
}

/**
 * Consume the token, execute fn, and write the result audit row.
 *
 * The intent row was written by authorize(); this writes exactly one result
 * row with ok=<boolean> (and the error code when fn throws) and rethrows the
 * original error. A result-audit failure after the effect throws
 * E_POLICY_AUDIT_UNAVAILABLE with effectCompleted:true: callers must surface
 * that loudly (the effect already happened and is not audited).
 *
 * @param {object} token from authorize()
 * @param {object} effect effect metadata
 * @param {Function} fn synchronous effect executor
 * @param {{now?: Date|number|string, audit?: Function, actor?: string}} [options]
 */
export function runWithDecision(token, effect, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('runWithDecision(token, effect, fn) requires a function')
  if (!isPlainObject(options)) throw new TypeError('runWithDecision options must be an object')
  const at = nowMs(options.now)
  const consumed = consumeDecision(token, effect, { now: at })
  const audit = options.audit
  let result
  try {
    result = fn()
  } catch (error) {
    writeAudit(
      audit,
      auditEvent({
        at: isoAt(at),
        actor: options.actor,
        surface: consumed.surface,
        action: consumed.action,
        policyAction: consumed.action,
        phase: 'result',
        decision: 'allow',
        decisionId: consumed.decisionId,
        effectDigest: consumed.effectDigest,
        ok: false,
        code: typeof error?.code === 'string' ? error.code : 'E_POLICY_EFFECT_FAILED',
      }),
    )
    throw error
  }
  const wrote = writeAudit(
    audit,
    auditEvent({
      at: isoAt(at),
      actor: options.actor,
      surface: consumed.surface,
      action: consumed.action,
      policyAction: consumed.action,
      phase: 'result',
      decision: 'allow',
      decisionId: consumed.decisionId,
      effectDigest: consumed.effectDigest,
      ok: true,
    }),
  )
  if (consumed.auditRequired && !wrote) {
    throw policyError('POLICY_AUDIT_UNAVAILABLE', 'the effect completed but its result audit could not be written', { effectCompleted: true, decisionId: consumed.decisionId })
  }
  return result
}

/** Drop every issued token (tests, long-lived processes after a failure). */
export function clearDecisionTokens() {
  tokens.clear()
}

/** Number of unexpired/unused tokens currently tracked (diagnostics). */
export function decisionTokenCount() {
  return tokens.size
}

export { PolicyError, effectDigestOf, canonicalJson, EFFECT_DIGEST_FIELDS }
