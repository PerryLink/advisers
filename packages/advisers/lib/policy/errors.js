/**
 * Policy error codes (0.4 subset): one place that maps an internal POLICY_*
 * reason to the public E_* code carried by error envelopes and CLI stderr.
 *
 * 0.4 does not activate exit codes 4/5/6 (contracts/cli/errors-v1.schema.json is
 * a closed schema); every code below keeps exit 1 except E_TOS_REQUIRED, which
 * keeps its historical exit 3.
 *
 * Registration note for lead/integration: the new E_POLICY_* literals must be
 * added to lib/error-codes.js (category 'policy', since '0.4.0') and regenerated
 * with `node scripts/check-contracts.mjs --update`; this module only defines the
 * runtime mapping so lib/ tests do not depend on bin/ wiring.
 */

/** Public code + operational metadata for every internal policy reason. */
export const POLICY_CODES = Object.freeze({
  POLICY_UNKNOWN_SURFACE: Object.freeze({ code: 'E_POLICY_UNKNOWN_SURFACE', exit: 1, category: 'policy', description: 'surface/action not registered; new paths fail closed' }),
  POLICY_SURFACE_NOT_ENABLED: Object.freeze({ code: 'E_POLICY_SURFACE_NOT_ENABLED', exit: 1, category: 'policy', description: 'registered but not wired/enabled yet (matrix gate not-wired)' }),
  POLICY_TOS_REQUIRED: Object.freeze({ code: 'E_TOS_REQUIRED', exit: 3, category: 'tos', description: 'current terms of service must be accepted' }),
  POLICY_SECRECY_BLOCKED: Object.freeze({ code: 'E_SECRECY_BLOCKED', exit: 1, category: 'policy', description: 'record belongs to a protected matter; egress/export blocked for that item' }),
  POLICY_CONSENT_REQUIRED: Object.freeze({ code: 'E_POLICY_CONSENT_REQUIRED', exit: 1, category: 'policy', description: 'model egress of mail/KB content requires an explicit consent record for surface+dataClass+provider' }),
  POLICY_CONFIRMATION_UNAVAILABLE: Object.freeze({ code: 'E_POLICY_CONFIRMATION_UNAVAILABLE', exit: 1, category: 'policy', description: 'untrusted content would drive a side effect and no interactive confirmation channel is available' }),
  POLICY_AUDIT_UNAVAILABLE: Object.freeze({ code: 'E_POLICY_AUDIT_UNAVAILABLE', exit: 1, category: 'policy', description: 'intent/result audit could not be written; the side effect is refused (fail closed)' }),
  POLICY_PROTECTED_PATH: Object.freeze({ code: 'E_POLICY_PROTECTED_PATH', exit: 1, category: 'policy', description: 'target path is a protected or persistence location' }),
  POLICY_WORKSPACE_ESCAPE: Object.freeze({ code: 'E_POLICY_WORKSPACE_ESCAPE', exit: 1, category: 'policy', description: 'target path escapes the workspace boundary' }),
  POLICY_CONTENT_SAFETY_BLOCKED: Object.freeze({ code: 'E_CONTENT_SAFETY_BLOCKED', exit: 1, category: 'content', description: 'content safety classifier blocked the content' }),
  POLICY_SAFETY_REQUIRED: Object.freeze({ code: 'E_POLICY_SAFETY_REQUIRED', exit: 1, category: 'policy', description: 'a content-safety verdict is required before this action but was not supplied' }),
  POLICY_INVALID_FACTS: Object.freeze({ code: 'E_POLICY_INVALID_FACTS', exit: 1, category: 'policy', description: 'policy facts are malformed or incomplete; fail closed instead of guessing' }),
  POLICY_EGRESS_UNREGISTERED: Object.freeze({ code: 'E_POLICY_EGRESS_UNREGISTERED', exit: 1, category: 'policy', description: 'egress sink/path is not registered in the egress registry' }),
  POLICY_TOKEN_INVALID: Object.freeze({ code: 'E_POLICY_TOKEN_INVALID', exit: 1, category: 'policy', description: 'decision token is malformed or was tampered with' }),
  POLICY_TOKEN_UNKNOWN: Object.freeze({ code: 'E_POLICY_TOKEN_UNKNOWN', exit: 1, category: 'policy', description: 'decision token was not issued by this process' }),
  POLICY_TOKEN_EXPIRED: Object.freeze({ code: 'E_POLICY_TOKEN_EXPIRED', exit: 1, category: 'policy', description: 'decision token expired before the effect was executed' }),
  POLICY_TOKEN_REPLAY: Object.freeze({ code: 'E_POLICY_TOKEN_REPLAY', exit: 1, category: 'policy', description: 'one-shot decision token was already consumed' }),
  POLICY_TOKEN_EFFECT_MISMATCH: Object.freeze({ code: 'E_POLICY_TOKEN_EFFECT_MISMATCH', exit: 1, category: 'policy', description: 'effect does not match the effect digest the decision was issued for' }),
})

/** Internal reason -> public code lookup (unknown reasons fail closed). */
export function policyCodeFor(reason) {
  const entry = POLICY_CODES[reason]
  return entry ? entry.code : 'E_POLICY_INVALID_FACTS'
}

export function policyCodeExit(reason) {
  const entry = POLICY_CODES[reason]
  return entry ? entry.exit : 1
}

/** JSON-ready code registry (docs/contracts/check scripts and tests). */
export function policyCodeRegistry() {
  return Object.keys(POLICY_CODES)
    .sort()
    .map((reason) => ({ reason, ...POLICY_CODES[reason] }))
}

/** A policy refusal with a stable public code; details are JSON-ready. */
export class PolicyError extends Error {
  constructor(reason, message, details) {
    const entry = POLICY_CODES[reason]
    const code = entry ? entry.code : 'E_POLICY_INVALID_FACTS'
    super(code + ': ' + (message || (entry ? entry.description : 'policy refused')))
    this.name = 'PolicyError'
    this.code = code
    this.policyCode = reason
    if (details && typeof details === 'object' && !Array.isArray(details)) this.details = { ...details }
  }
}

/** Build a PolicyError for an internal policy reason. */
export function policyError(reason, message, details) {
  return new PolicyError(reason, message, details)
}
