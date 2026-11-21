/**
 * Policy surface registry (0.4 subset).
 *
 * The 0.2/0.3 "six surfaces" list in docs/ARCHITECTURE.md is a design sketch;
 * 0.4 ships a registry instead, because mail/KB/TUI/notify add data surfaces and
 * a matrix must be generated, never hand-maintained. Every row records the
 * honest gate state for that surface in 0.4:
 *
 *   enforced-policy  goes through lib/policy evaluate()/authorize()
 *   legacy-gate      pre-0.4 gate only (active-matter egress, TOS, clearance)
 *   self-attested    local-only path with no egress; the docs claim no more
 *   not-wired        registered but not enabled in 0.4 (default off)
 *
 * Modules are pure data: no I/O, no network, no timestamps. lib/policy/index.js
 * publishes surfaceMatrix() for `privacy --matrix` and for docs/contract gates.
 */

export const POLICY_VERSION = 1
export const RULESET_VERSION = '2026.11.4'

/** Gate states; kept in sync with docs/ARCHITECTURE.md and SECURITY.md rows. */
export const SURFACE_GATES = Object.freeze(['enforced-policy', 'legacy-gate', 'self-attested', 'not-wired'])

/** Default enablement of a surface in 0.4. */
export const SURFACE_DEFAULTS = Object.freeze(['on', 'off'])

/**
 * One row per surface.
 *
 * actions      canonical policy actions the surface may request
 * dataClass    the most sensitive data class the surface can carry
 * sink         where data can leave the process ('none' for read-only)
 * default      on = usable after the normal gates; off = requires an explicit
 *              local enablement (consent entry / config flag)
 * gate         honest wiring state in 0.4 (see header)
 * tosRef       clause covering this surface (docs/TOS.md)
 * doc          user-facing documentation
 */
export const SURFACE_REGISTRY = Object.freeze([
  Object.freeze({ surface: 'chat', description: 'interactive model chat', actions: Object.freeze(['model-egress']), dataClass: 'conversation', sink: 'model', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'capture', description: 'model-assisted candidate extraction', actions: Object.freeze(['model-egress']), dataClass: 'conversation', sink: 'model', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/SOURCE-SCHEMA.md' }),
  Object.freeze({ surface: 'research', description: 'web research via the configured model', actions: Object.freeze(['model-egress']), dataClass: 'conversation', sink: 'model', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'agent', description: 'agent tool loop (read/write/exec)', actions: Object.freeze(['read', 'write-fs', 'write-ledger', 'exec', 'model-egress']), dataClass: 'tool', sink: 'spawn', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#5', doc: 'docs/SAFETY.md' }),
  Object.freeze({ surface: 'mcp', description: 'MCP read-only projection', actions: Object.freeze(['read']), dataClass: 'ledger', sink: 'none', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3', doc: 'docs/MCP.md' }),
  Object.freeze({ surface: 'dsh', description: 'DeepSeek Harness read-only projection', actions: Object.freeze(['read']), dataClass: 'ledger', sink: 'none', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3', doc: 'docs/PLUGIN-BOUNDARY.md' }),
  Object.freeze({ surface: 'pet-brief', description: 'portable brief for consumer agents', actions: Object.freeze(['read', 'export']), dataClass: 'ledger', sink: 'fs', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/PET-BRIEF-CONSUMERS.md' }),
  Object.freeze({ surface: 'export', description: 'evidence/export packs and delivery receipts', actions: Object.freeze(['export']), dataClass: 'ledger', sink: 'fs', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3', doc: 'docs/DELIVERY-RECEIPT.md' }),
  Object.freeze({ surface: 'mail.sync', description: 'IMAP sync to the user-configured mailbox', actions: Object.freeze(['net-egress']), dataClass: 'mail', sink: 'net', default: 'on', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'mail.extract', description: 'mail candidate extraction (local rules or explicit model opt-in)', actions: Object.freeze(['read', 'model-egress']), dataClass: 'mail', sink: 'model', default: 'off', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'kb.ingest', description: 'local KB ingest (no egress)', actions: Object.freeze(['read', 'write-ledger']), dataClass: 'kb', sink: 'fs', default: 'on', gate: 'self-attested', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'kb.search', description: 'local KB search (clearance-filtered)', actions: Object.freeze(['read']), dataClass: 'kb', sink: 'none', default: 'on', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'kb.ask', description: 'model-assisted KB answers (explicit opt-in)', actions: Object.freeze(['read', 'model-egress']), dataClass: 'kb', sink: 'model', default: 'off', gate: 'enforced-policy', tosRef: 'docs/TOS.md#9.3', doc: 'docs/ARCHITECTURE.md' }),
  Object.freeze({ surface: 'notify.webhook', description: 'outbound notification webhook', actions: Object.freeze(['net-egress']), dataClass: 'reminder', sink: 'net', default: 'off', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/REMINDERS.md' }),
  Object.freeze({ surface: 'bridge', description: 'Hermes bridge file exchange', actions: Object.freeze(['read', 'net-egress', 'send']), dataClass: 'conversation', sink: 'net', default: 'off', gate: 'legacy-gate', tosRef: 'docs/TOS.md#9.3', doc: 'docs/PLUGIN-BOUNDARY.md' }),
  Object.freeze({ surface: 'tui', description: 'TUI shell dispatch (no data egress of its own)', actions: Object.freeze(['read']), dataClass: 'ledger', sink: 'none', default: 'on', gate: 'self-attested', tosRef: 'docs/TOS.md#9.3', doc: 'docs/TUI.md' }),
])

/** Canonical policy actions understood by evaluate(). */
export const POLICY_ACTIONS = Object.freeze([
  'read', 'write-ledger', 'write-fs', 'exec', 'send', 'model-egress', 'net-egress', 'export', 'delete',
])

/** Canonical data classes carried by a policy decision. */
export const DATA_CLASSES = Object.freeze([
  'conversation', 'ledger', 'mail', 'kb', 'attachment', 'reminder', 'web', 'tool', 'credential', 'unknown',
])

/** Actions that need a TOS acceptance fact before they are allowed. */
export const TOS_REQUIRED_ACTIONS = Object.freeze([
  'read', 'write-ledger', 'write-fs', 'exec', 'send', 'model-egress', 'net-egress', 'export', 'delete',
])

/** Actions that leave the process / mutate durable state (audit + fail-closed). */
export const SIDE_EFFECT_ACTIONS = Object.freeze([
  'write-ledger', 'write-fs', 'exec', 'send', 'model-egress', 'net-egress', 'export', 'delete',
])

/** Actions that egress data to a model or the network. */
export const EGRESS_ACTIONS = Object.freeze(['model-egress', 'net-egress', 'send'])

/** Read-only projections that respect per-record clearance. */
export const CLEARANCE_ACTIONS = Object.freeze(['read', 'export'])

/**
 * Actions whose input content must carry a safety verdict before they are
 * allowed. Legacy (0.4) call sites that already ran inspectCaptureText / the
 * safety classifier pass {action:'allow'}; new data surfaces fail closed when
 * the verdict is absent.
 */
export const SAFETY_REQUIRED_ACTIONS = Object.freeze(['model-egress', 'send', 'export'])

/** Actions whose target path must be classified (workspace boundary enforcement). */
export const PATH_ACTIONS = Object.freeze(['write-fs', 'delete'])

const SURFACE_BY_NAME = new Map(SURFACE_REGISTRY.map((row) => [row.surface, row]))

/** Canonical surface name or null (case/space tolerant, never guesses). */
export function normalizeSurface(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  return SURFACE_BY_NAME.has(text) ? text : null
}

/** Surface registry row or null. */
export function getSurface(value) {
  const name = normalizeSurface(value)
  return name ? SURFACE_BY_NAME.get(name) : null
}

/** True when the surface declares the action. */
export function surfaceSupportsAction(surface, action) {
  const row = getSurface(surface)
  if (!row || typeof action !== 'string') return false
  return row.actions.includes(action)
}

/** True when the surface is gate 'not-wired' (registered but disabled in 0.4). */
export function surfaceNotWired(surface) {
  const row = getSurface(surface)
  return Boolean(row) && row.gate === 'not-wired'
}

/** Deterministic JSON-ready matrix (used by privacy --matrix and docs gates). */
export function surfaceMatrix() {
  return {
    policyVersion: POLICY_VERSION,
    rulesetVersion: RULESET_VERSION,
    rows: SURFACE_REGISTRY.map((row) => ({
      surface: row.surface,
      description: row.description,
      actions: [...row.actions],
      dataClass: row.dataClass,
      sink: row.sink,
      default: row.default,
      gate: row.gate,
      tosRef: row.tosRef,
      doc: row.doc,
    })),
  }
}
