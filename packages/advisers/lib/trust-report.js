/**
 * Trust outputs for 0.4.3 (work package 043-3): `doctor --report` and
 * `privacy --prove --brief`.
 *
 * This is the library layer only: bin/advisers.js owns flags, output mode,
 * command registration, the TOS exception table and the doctor check table.
 * There is no model call, no network and no ledger write here. The one read is
 * the packaged package.json version fallback (same pattern as lib/evidence.js
 * and lib/client-pack.js; bundled/copied layouts may not ship it).
 *
 * Why explicit null (91 §5.3, 97:103): an unmeasured quality dimension must be
 * `null` and carry a reason in `nulls[]`. `0`, `false` and `PASS` would read as
 * measurements. `realMailAccount` / `win11RealMachine` are null too: this
 * report does not probe a live mailbox or a Win11 real machine, and 97's hard
 * rule forbids using `false` instead of `null` for exactly those dimensions
 * (91:178's sample JSON predates that rule). `ok` only mirrors the caller's
 * check table; it never asserts a capability or a quality level.
 *
 * Why the four-line privacy card: `privacy --prove` is a local
 * self-attestation. The brief condenses the same facts into at-rest / sync /
 * export / egress lines, each naming the doc that is the source of the claim
 * (`docsClaims`), so a test can assert the card and PRIVACY/SYNC/
 * AT-REST-VAULT say the same thing instead of drifting apart. The fancier
 * prose stays out of the CLI full output, which is unchanged.
 */
import { readFileSync } from 'node:fs'
import { stripBidiControls, stripControlChars, stripTerminalSequences } from './text-safe.js'

/** Version of the `doctor --report` JSON contract. */
export const DOCTOR_REPORT_VERSION = 1
/** Version of the `privacy --prove --brief` data contract. */
export const PRIVACY_BRIEF_VERSION = 1

/**
 * Every quality/verification dimension this report refuses to invent, with the
 * reason it is null. This object is the single source of `measured` keys and
 * `nulls[]`: adding a dimension here adds both, so a null can never be emitted
 * without a reason. Frozen so no caller can quietly replace a null with 0.
 */
export const DOCTOR_MEASURED_DIMENSIONS = Object.freeze({
  modelQuality: 'no independent human gold standard; local suites are deterministic regression gates, not model-quality measurements',
  semanticCorrectness: 'no human-labelled semantic gold set; deterministic suites check structure and contracts only',
  captureQuality: 'no labelled capture corpus; capture rules are deterministic pattern matching, not a measured quality',
  independentGoldStandard: 'no independent (non-implementer) human gold standard exists for this build',
  realMailAccount: 'no real mail account was verified against a live server for this build; local mail tests use synthetic .eml fixtures',
  win11RealMachine: 'Windows CI is not real-machine verification; no Win11 manual record covers this build',
  windowsClientIme: 'no Windows IME / office-client sweep was run for this build',
  officeAppFidelity: 'no Office/WPS app-fidelity check was run; verify --content checks the package contract, not app rendering',
  externalTimestamp: 'no external timestamp authority was contacted; audit anchors are local HMAC and prove local tamper-evidence only',
})

/** The measured keys in insertion order (tests iterate this, never a copy). */
export const DOCTOR_MEASURED_KEYS = Object.freeze(Object.keys(DOCTOR_MEASURED_DIMENSIONS))

/** Standing notices of every report (stable, truthful, no measured numbers). */
export const DOCTOR_NOTICES = Object.freeze([
  'local self-attestation: this report is built from this installation\'s files, environment and code constants; it performs no network calls and is not a third-party audit or compliance certification',
  'regression gates (deterministic structural cases and the zero-model synthetic mail gate) prove contracts, not model quality',
])

/** Standing limitations of every report. */
export const DOCTOR_LIMITATIONS = Object.freeze([
  'unknown is null, never 0/false/PASS: each null in measured has a reason in nulls[] and stays unknown until it is actually measured',
  'ok mirrors only the check table (when the caller ran one); it does not assert any capability, accuracy or quality level',
  'no independent human gold standard, live-model evaluation, real mail account, Win11 real machine, Office/WPS client fidelity or external timestamp authority was verified for this report',
])

/**
 * The four `privacy --prove --brief` lines, in fixed order.
 *
 * `docs` names the file that owns the claim and `docsClaims` lists literal
 * fragments that must appear in that file. The card is therefore a projection of
 * the docs, not a second story: test/trust-report.test.js reads the docs and
 * asserts every docsClaims entry is present. `state` is the short status token;
 * `command` is the local follow-up a user can run to check further.
 */
export const PRIVACY_BRIEF_LINES = Object.freeze([
  Object.freeze({
    key: 'at-rest',
    label: 'at-rest',
    claim: '数据库默认明文；加密是可选的 vault（AES-256-GCM + scrypt，显式 opt-in，不是默认开启）',
    state: 'plaintext-by-default',
    command: 'advisers vault status',
    docs: 'docs/AT-REST-VAULT.md',
    docsClaims: Object.freeze(['AES-256-GCM', 'opt-in']),
  }),
  Object.freeze({
    key: 'sync',
    label: 'sync',
    claim: '可选：整库加密快照（AES-256-GCM + scrypt）写入你指定的目录；没有同步服务器，没有自动合并（last-snapshot-wins）',
    state: 'opt-in-encrypted-snapshots',
    command: 'advisers sync status --dir <dir>',
    docs: 'docs/SYNC.md',
    docsClaims: Object.freeze(['AES-256-GCM', 'Last-snapshot-wins']),
  }),
  Object.freeze({
    key: 'export',
    label: 'export',
    claim: 'export --all 默认明文，--encrypted 可选；输出文件由你指定并保管，本命令不自动上传',
    state: 'on-demand-plaintext-unless-encrypted',
    command: 'advisers export --all [--encrypted]',
    docs: 'docs/PRIVACY.md',
    docsClaims: Object.freeze(['export --all', '--encrypted']),
  }),
  Object.freeze({
    key: 'egress',
    label: 'egress',
    claim: '默认不会出网：没有账号、没有遥测、没有自动更新检查；只有你显式配置/启用的面（模型、IMAP、通知、sync、bridge、MCP/DSH 等）才会发出数据',
    state: 'none-by-default',
    command: 'advisers privacy --prove',
    docs: 'docs/PRIVACY.md',
    docsClaims: Object.freeze(['不会出网']),
  }),
])

/** One-line, terminal-safe text for a caller-supplied notice/limitation. */
function oneLine(value, field) {
  if (typeof value !== 'string') throw new TypeError('doctor report ' + field + ' entries must be strings')
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(value)), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) throw new TypeError('doctor report ' + field + ' entries must not be empty')
  return text
}

function normalizeLines(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError('doctor report ' + field + ' must be an array')
  return value.map((entry) => oneLine(entry, field))
}

function normalizeGeneratedAt(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw new TypeError('doctor report generatedAt must be a valid date/ISO string')
  return date.toISOString()
}

function normalizeSchemaVersion(value) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new TypeError('doctor report schemaVersion must be a non-negative integer or null')
  return value
}

/**
 * Runtime schema version: an explicit number/null wins, else the caller may
 * pass the opened SQLite `store` and its schemaVersion() is used. A JSON store
 * has no schema, so its caller passes `schemaVersion: null`.
 */
function resolveSchemaVersion(opts) {
  if (opts.schemaVersion !== undefined) return normalizeSchemaVersion(opts.schemaVersion)
  const store = opts.store
  if (store && typeof store === 'object' && typeof store.schemaVersion === 'function') {
    try {
      const value = store.schemaVersion()
      return Number.isInteger(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  }
  return null
}

function normalizeOk(value) {
  if (value === undefined || value === null) return true
  if (typeof value !== 'boolean') throw new TypeError('doctor report ok must be a boolean')
  return value
}

let advisersVersionCache
/** Packaged version fallback (a bundled/copied layout may not ship package.json). */
function resolveAdvisersVersion(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') {
    throw new TypeError('doctor report advisersVersion must be a string')
  }
  if (advisersVersionCache !== undefined) return advisersVersionCache
  advisersVersionCache = null
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version) advisersVersionCache = pkg.version
  } catch {
    // Bundled/copied layouts may not ship package.json next to lib/.
  }
  return advisersVersionCache
}

/**
 * Assemble the `doctor --report --json` payload. Pure except generatedAt.
 *
 * @param {{ok?: boolean, generatedAt?: string|Date, advisersVersion?: string,
 *          schemaVersion?: number|null, store?: object, notices?: string[],
 *          limitations?: string[]}} [options] `schemaVersion` wins over
 *          `store.schemaVersion()`; with neither it is null (JSON store).
 * @returns {{ok: boolean, mode: 'report', reportVersion: number,
 *            generatedAt: string, advisersVersion: string|null,
 *            schemaVersion: number|null, measured: Record<string, null>,
 *            nulls: {key: string, reason: string}[],
 *            notices: string[], limitations: string[]}}
 */
export function buildDoctorReport(options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const generatedAt = normalizeGeneratedAt(opts.generatedAt)
  const ok = normalizeOk(opts.ok)
  const schemaVersion = resolveSchemaVersion(opts)
  const advisersVersion = resolveAdvisersVersion(opts.advisersVersion)
  const measured = {}
  const nulls = []
  for (const key of DOCTOR_MEASURED_KEYS) {
    measured[key] = null
    nulls.push({ key, reason: DOCTOR_MEASURED_DIMENSIONS[key] })
  }
  const notices = [...DOCTOR_NOTICES, ...normalizeLines(opts.notices, 'notices')]
  const limitations = [...DOCTOR_LIMITATIONS, ...normalizeLines(opts.limitations, 'limitations')]
  return {
    ok,
    mode: 'report',
    reportVersion: DOCTOR_REPORT_VERSION,
    generatedAt,
    advisersVersion,
    schemaVersion,
    measured,
    nulls,
    notices: [...new Set(notices)],
    limitations: [...new Set(limitations)],
  }
}

/**
 * Assemble the `privacy --prove --brief` four-line data.
 *
 * @param {{generatedAt?: string|Date, vaultSealed?: boolean|null}} [options]
 * @returns {{ok: true, mode: 'brief', briefVersion: number, generatedAt: string,
 *            notice: string, lines: object[]}}
 */
export function buildPrivacyBrief(options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const generatedAt = normalizeGeneratedAt(opts.generatedAt)
  let atRestState = null
  if (opts.vaultSealed === true) atRestState = 'sealed-vault'
  else if (opts.vaultSealed === false) atRestState = 'plaintext-db'
  const lines = PRIVACY_BRIEF_LINES.map((line) => ({
    key: line.key,
    label: line.label,
    claim: line.claim,
    state: line.key === 'at-rest' && atRestState !== null ? atRestState : line.state,
    command: line.command,
    docs: line.docs,
    docsClaims: [...line.docsClaims],
  }))
  return {
    ok: true,
    mode: 'brief',
    briefVersion: PRIVACY_BRIEF_VERSION,
    generatedAt,
    notice: '本地自检口径：四行卡只陈述本机可验证的数据流向；不是第三方审计、不是合规认证，本命令不联网。',
    lines,
  }
}

/**
 * Render the four-line card as single-line strings (the CLI prints one per line).
 * Byte-stable for a given brief: label column, claim, then the doc that owns it.
 */
export function formatPrivacyBrief(brief) {
  if (!brief || !Array.isArray(brief.lines)) throw new TypeError('formatPrivacyBrief requires a brief from buildPrivacyBrief')
  return brief.lines.map((line) => {
    const label = oneLine(line.label, 'brief line label')
    const claim = oneLine(line.claim, 'brief line claim')
    const docs = oneLine(line.docs, 'brief line docs')
    return label.padEnd(8) + claim + '  [' + docs + ']'
  })
}

export default Object.freeze({
  DOCTOR_REPORT_VERSION,
  PRIVACY_BRIEF_VERSION,
  DOCTOR_MEASURED_DIMENSIONS,
  DOCTOR_MEASURED_KEYS,
  DOCTOR_NOTICES,
  DOCTOR_LIMITATIONS,
  PRIVACY_BRIEF_LINES,
  buildDoctorReport,
  buildPrivacyBrief,
  formatPrivacyBrief,
})
