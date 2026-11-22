/**
 * Egress registry (0.4 subset) + checkEgress(kind, meta).
 *
 * Why a registry: every place where data can leave the process (model, network,
 * files, paths exported to a counterparty) must be discoverable from one list,
 * so a new data surface cannot silently grow its own private gate. Each row
 * records surface/action/dataClass/sink/entry/default/gate/tosRef plus the
 * documentation clause that promises it.
 *
 * 0.4 registers the paths that exist at integration time (chat/capture/research/
 * bridge model calls, IMAP sync, notify webhook, export packs) and the new
 * mail.extract / kb.ask model paths landing in 0.4 (default off until consent
 * exists). A static wiring gate (scripts/, lead-owned) can scan the model/net
 * call sites and require each one to appear here; this module only owns the
 * data + runtime check.
 *
 * lib/egress.js (matter secrecy guard) is intentionally untouched: it keeps its
 * legacy exports/behaviour; this is an additive registry next to it.
 */
import { policyError } from './errors.js'
import { evaluate } from './rules.js'
import { getSurface, normalizeSurface } from './surfaces.js'

/** Egress sink kinds: where data is going. */
export const EGRESS_SINKS = Object.freeze(['model', 'net', 'send', 'fs', 'export', 'spawn', 'local'])

const SINK_ALIASES = Object.freeze({
  model: 'model',
  'model-egress': 'model',
  chat: 'model',
  llm: 'model',
  net: 'net',
  'net-egress': 'net',
  network: 'net',
  webhook: 'net',
  send: 'send',
  mail: 'send',
  fs: 'fs',
  file: 'fs',
  disk: 'fs',
  export: 'export',
  pack: 'export',
  spawn: 'spawn',
  exec: 'spawn',
  local: 'local',
})

const RUNTIME_FACT_KEYS = Object.freeze([
  'facts', 'tos', 'consent', 'record', 'safety', 'trust', 'audit', 'path', 'clearance',
  'interactive', 'confirmed', 'dataClass', 'provider', 'baseUrl', 'actor', 'now',
])

/**
 * One row per registered egress path.
 *
 * default 'on'  usable after the normal gates (TOS/key/config),
 *         'off' requires an explicit local enablement (e.g. consent entry).
 * gate matches the surface registry gate for the same surface.
 */
export const EGRESS_REGISTRY = Object.freeze([
  Object.freeze({ id: 'chat.model', surface: 'chat', action: 'model-egress', dataClass: 'conversation', sink: 'model', entry: 'lib/model.js#chatCompletion', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'capture.model', surface: 'capture', action: 'model-egress', dataClass: 'conversation', sink: 'model', entry: 'lib/capture.js#captureCandidates', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'research.model', surface: 'research', action: 'model-egress', dataClass: 'conversation', sink: 'model', entry: 'lib/research.js#research', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'agent.model', surface: 'agent', action: 'model-egress', dataClass: 'conversation', sink: 'model', entry: 'lib/agent.js#runAgent', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'bridge.model', surface: 'bridge', action: 'net-egress', dataClass: 'conversation', sink: 'net', entry: 'packages/bridge-hermes', default: 'off', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'notify.webhook', surface: 'notify.webhook', action: 'net-egress', dataClass: 'reminder', sink: 'net', entry: 'lib/notify.js#sendWebhookNotification', default: 'off', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'mail.sync', surface: 'mail.sync', action: 'net-egress', dataClass: 'mail', sink: 'net', entry: 'lib/mail.js#mailSync', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'mail.extract.model', surface: 'mail.extract', action: 'model-egress', dataClass: 'mail', sink: 'model', entry: 'lib/mail-extract.js#extractCandidatesWithModel', default: 'off', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'kb.ask.model', surface: 'kb.ask', action: 'model-egress', dataClass: 'kb', sink: 'model', entry: 'lib/kb.js (model ask planned 0.4.x; local kbSearch ships in 0.4)', default: 'off', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'export.evidence-pack', surface: 'export', action: 'export', dataClass: 'ledger', sink: 'fs', entry: 'lib/evidence.js#buildEvidencePack', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'export.receipt-pack', surface: 'export', action: 'export', dataClass: 'ledger', sink: 'fs', entry: 'lib/evidence.js#buildReceiptPack', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3' }),
  // 0.5.0 context pack: a local filesystem export surface (no network row).
  Object.freeze({ id: 'export.context-pack', surface: 'export', action: 'export', dataClass: 'ledger', sink: 'fs', entry: 'lib/context-pack.js#buildContextPack', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'export.pet-brief', surface: 'pet-brief', action: 'export', dataClass: 'ledger', sink: 'fs', entry: 'lib/pet-brief.js#buildPetBrief', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'kb.ingest.local', surface: 'kb.ingest', action: 'write-ledger', dataClass: 'kb', sink: 'fs', entry: 'lib/kb.js#kbAdd', default: 'on', gate: 'self-attested', tosRef: 'docs/TOS.md#9.3' }),
  Object.freeze({ id: 'agent.exec', surface: 'agent', action: 'exec', dataClass: 'tool', sink: 'spawn', entry: 'lib/agent.js#executeTool', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#5' }),
])

const ENTRY_BY_ID = new Map(EGRESS_REGISTRY.map((entry) => [entry.id, entry]))

/** Canonical egress sink kind or null. */
export function normalizeEgressKind(value) {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return SINK_ALIASES[key] ?? null
}

/** Deterministic JSON-ready registry copy (for docs/contract tests). */
export function listEgress() {
  return EGRESS_REGISTRY.map((entry) => ({
    id: entry.id,
    surface: entry.surface,
    action: entry.action,
    dataClass: entry.dataClass,
    sink: entry.sink,
    entry: entry.entry,
    default: entry.default,
    gate: entry.gate,
    tosRef: entry.tosRef,
  }))
}

/** Registry row by id. */
export function getEgressEntry(id) {
  return typeof id === 'string' ? ENTRY_BY_ID.get(id) ?? null : null
}

function matchEntries(kind, meta) {
  const sink = normalizeEgressKind(kind)
  if (!sink) return { sink: null, entries: [] }
  if (typeof meta?.id === 'string' && meta.id) {
    const entry = ENTRY_BY_ID.get(meta.id)
    return { sink, entries: entry && entry.sink === sink ? [entry] : [] }
  }
  let entries = EGRESS_REGISTRY.filter((entry) => entry.sink === sink)
  const surface = normalizeSurface(meta?.surface)
  if (surface) entries = entries.filter((entry) => entry.surface === surface)
  const action = typeof meta?.action === 'string' ? meta.action.trim() : ''
  if (action) entries = entries.filter((entry) => entry.action === action)
  const dataClass = typeof meta?.dataClass === 'string' ? meta.dataClass.trim() : ''
  if (dataClass) entries = entries.filter((entry) => entry.dataClass === dataClass)
  return { sink, entries }
}

/**
 * Static registry lookup: the registered egress row for a sink + selector.
 * Returns null for unknown/ambiguous paths (never guesses between rows).
 *
 * @param {string} kind sink ('model'|'net'|'send'|'fs'|'export'|'spawn'|'local')
 * @param {{id?: string, surface?: string, action?: string, dataClass?: string}} [meta]
 */
export function findEgressEntry(kind, meta = {}) {
  const matched = matchEntries(kind, meta)
  if (!matched.sink || matched.entries.length !== 1) return null
  return matched.entries[0]
}

function registryOnlyResult(sink, entry) {
  const surfaceRow = getSurface(entry.surface)
  return {
    v: 1,
    kind: sink,
    id: entry.id,
    registered: true,
    checked: false,
    entry: listEgress().find((row) => row.id === entry.id),
    gate: surfaceRow ? surfaceRow.gate : entry.gate,
    default: entry.default,
    decision: 'not_checked',
    code: null,
    policyCode: null,
    ruleIds: [],
    obligations: [],
    reason: 'registry-only check: runtime facts (tos/audit/consent/record/safety) were not supplied; call evaluate() or pass them as meta to get a decision',
  }
}

function hasRuntimeFacts(meta) {
  if (!meta || typeof meta !== 'object') return false
  return RUNTIME_FACT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(meta, key))
}

function factsFromMeta(entry, meta) {
  if (meta && typeof meta.facts === 'object' && meta.facts !== null) {
    return {
      ...meta.facts,
      surface: meta.facts.surface ?? entry.surface,
      action: meta.facts.action ?? entry.action,
      dataClass: meta.facts.dataClass ?? entry.dataClass,
    }
  }
  const facts = {}
  for (const key of RUNTIME_FACT_KEYS) {
    if (key === 'facts') continue
    if (meta[key] !== undefined) facts[key] = meta[key]
  }
  facts.surface = typeof meta.surface === 'string' && meta.surface ? meta.surface : entry.surface
  facts.action = typeof meta.action === 'string' && meta.action ? meta.action : entry.action
  facts.dataClass = typeof meta.dataClass === 'string' && meta.dataClass ? meta.dataClass : entry.dataClass
  if (meta.provider !== undefined) facts.provider = meta.provider
  return facts
}

/**
 * Check one egress path.
 *
 * 1. The sink must be known and the path registered (otherwise deny with
 *    E_POLICY_EGRESS_UNREGISTERED/E_POLICY_UNKNOWN_SURFACE).
 * 2. When runtime facts are supplied (directly or as meta.facts), the call
 *    delegates to evaluate() and returns its decision with the registry row.
 * 3. Without runtime facts it returns decision 'not_checked' (registry-only
 *    probe for docs gates/tests) instead of pretending to have checked.
 *
 * @param {string} kind egress sink
 * @param {object} [meta] selector {id?, surface?, action?, dataClass?} + runtime facts
 * @returns {object} JSON-ready {kind, registered, entry, decision, code,
 *                   policyCode, ruleIds, obligations, reason, checked}
 */
export function checkEgress(kind, meta = {}) {
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw new TypeError('checkEgress(kind, meta) requires a meta object')
  }
  const selector = meta || {}
  const matched = matchEntries(kind, selector)
  if (!matched.sink) {
    const error = policyError('POLICY_EGRESS_UNREGISTERED', 'unknown egress sink kind')
    return {
      v: 1,
      kind: null,
      id: null,
      registered: false,
      checked: false,
      entry: null,
      decision: 'deny',
      code: error.code,
      policyCode: error.policyCode,
      ruleIds: [],
      obligations: [],
      reason: 'unknown egress sink kind; register it before it can be used',
    }
  }
  if (matched.entries.length === 0) {
    const error = policyError('POLICY_EGRESS_UNREGISTERED', 'egress path is not registered')
    return {
      v: 1,
      kind: matched.sink,
      id: null,
      registered: false,
      checked: false,
      entry: null,
      decision: 'deny',
      code: error.code,
      policyCode: error.policyCode,
      ruleIds: [],
      obligations: [],
      reason: 'egress path is not registered in the egress registry; new paths fail closed',
    }
  }
  if (matched.entries.length > 1) {
    return {
      v: 1,
      kind: matched.sink,
      id: null,
      registered: false,
      checked: false,
      entry: null,
      candidates: matched.entries.map((entry) => entry.id).sort(),
      decision: 'deny',
      code: 'E_POLICY_EGRESS_UNREGISTERED',
      policyCode: 'POLICY_EGRESS_UNREGISTERED',
      ruleIds: [],
      obligations: [],
      reason: 'ambiguous egress path: pass meta.id (one of the candidates) to disambiguate',
    }
  }
  const entry = matched.entries[0]
  if (!hasRuntimeFacts(selector)) return registryOnlyResult(matched.sink, entry)
  const facts = factsFromMeta(entry, selector)
  const decision = evaluate(facts)
  return {
    ...decision,
    kind: matched.sink,
    id: entry.id,
    registered: true,
    checked: true,
    entry: listEgress().find((row) => row.id === entry.id),
    gate: getSurface(entry.surface) ? getSurface(entry.surface).gate : entry.gate,
    default: entry.default,
  }
}
