/**
 * Policy 0.4 subset — public module API.
 *
 * bin/MCP wiring is lead-owned; this barrel is what the integration is expected
 * to import:
 *
 *   import { evaluate, authorize, runWithDecision, checkEgress,
 *            loadConsent, saveConsent, consentFacts } from '../lib/policy/index.js'
 *
 * - evaluate(facts)          pure decision (allow|confirm|deny, E_* code, rules,
 *                            obligations, effectDigest)
 * - authorize(action,facts)  decision + one-shot decision token + intent audit
 * - runWithDecision(token, effect, fn)  digest-checked execution + result audit
 * - checkEgress(kind, meta)  egress registry lookup + optional evaluate
 * - loadConsent/saveConsent  $ADVISERS_HOME/consent.json (0600, atomic)
 *
 * Exit-code contract: unchanged (0/1/3). Policy detail travels in
 * error.details.{policyCode,decisionId,ruleIds,surface,action}; exit 4/5/6 and
 * errors/exit v2 stay 0.5 work.
 */

export {
  POLICY_CODES,
  PolicyError,
  policyCodeExit,
  policyCodeFor,
  policyCodeRegistry,
  policyError,
} from './errors.js'

export {
  CLEARANCE_ACTIONS,
  DATA_CLASSES,
  EGRESS_ACTIONS,
  PATH_ACTIONS,
  POLICY_ACTIONS,
  POLICY_VERSION,
  RULESET_VERSION,
  SAFETY_REQUIRED_ACTIONS,
  SIDE_EFFECT_ACTIONS,
  SURFACE_DEFAULTS,
  SURFACE_GATES,
  SURFACE_REGISTRY,
  TOS_REQUIRED_ACTIONS,
  getSurface,
  normalizeSurface,
  surfaceMatrix,
  surfaceNotWired,
  surfaceSupportsAction,
} from './surfaces.js'

export {
  EFFECT_DIGEST_FIELDS,
  POLICY_RULES,
  canonicalFacts,
  canonicalJson,
  effectDigestOf,
  evaluate,
} from './rules.js'

export {
  DECISION_TOKEN_TTL_MS,
  authorize,
  clearDecisionTokens,
  consumeDecision,
  decisionTokenCount,
  decisionView,
  runWithDecision,
} from './decision.js'

export {
  EGRESS_REGISTRY,
  EGRESS_SINKS,
  checkEgress,
  findEgressEntry,
  getEgressEntry,
  listEgress,
  normalizeEgressKind,
} from './egress.js'

export {
  CONSENT_CHANNELS,
  CONSENT_DIR_MODE,
  CONSENT_FILE,
  CONSENT_FILE_MODE,
  CONSENT_VERSION,
  consentFacts,
  consentPath,
  consentStatus,
  defaultHome,
  grantConsent,
  listConsents,
  loadConsent,
  readConsent,
  revokeConsent,
  saveConsent,
  validateConsentRecord,
  writeConsent,
} from '../consent.js'
