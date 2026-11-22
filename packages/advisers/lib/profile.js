/**
 * Read-only personal-model profile over the `preferences` table (0.4.3 043-3).
 *
 * `advisers profile show|export` is the only consumer: it reads preferences,
 * groups them by scope then kind, and renders a stable JSON payload or a
 * Markdown export. There is no model call, no network, no ledger write and no
 * wall-clock field in the payload: two runs over the same rows (and the same
 * decay clock) are byte-identical, and every item/export carries a dataSha256
 * over exactly the fields a consumer can see, so determinism is verifiable
 * rather than asserted.
 *
 * Interpretation choices (documented because the schema has no such columns):
 * - `authority` is derived from the persisted `source.type`
 *   (user_explicit -> user, imported -> import, tool -> tool,
 *   inferred -> inferred); absent/unknown source types stay null instead of
 *   being guessed;
 * - `decayedConfidence` is a projection of lib/learning.js's
 *   applyPreferenceDecay (0.8 per 30 days, only when the age is >= 30 days,
 *   skipped for priority='hard' and status='deprecated') and is NEVER written
 *   back -- the profile command is read-only, so decay is not forced on a user
 *   who only wanted to look at their model;
 * - all stored statuses are shown (including candidate/deprecated). Hiding a
 *   row would be a silent forget; the card says what it is instead.
 *
 * Input: the mapped preference rows returned by `store.loadPreferences()`
 * (SQLite, all statuses) or the JSON ledger's `listPreferences({
 * includeCandidates:true })`. The module never touches the store itself.
 */
import { createHash } from 'node:crypto'
import { stripBidiControls, stripControlChars, stripTerminalSequences } from './text-safe.js'

/** Version of the `profile` JSON payload contract. */
export const PROFILE_VERSION = 1
/** Where the profile comes from (kept in the payload for future sources). */
export const PROFILE_SOURCE = 'preferences'
/** Scope ordering used to group and sort (broad -> narrow). */
export const PROFILE_SCOPE_LEVELS = Object.freeze(['global', 'project', 'matter', 'audience'])
/** Decay constants, mirroring lib/learning.js applyPreferenceDecay(). */
export const PROFILE_DECAY = Object.freeze({ windowDays: 30, factor: 0.8 })
/** PreferenceSourceType -> the repo's Authority vocabulary. */
export const PROFILE_AUTHORITY_BY_SOURCE = Object.freeze({
  user_explicit: 'user',
  imported: 'import',
  tool: 'tool',
  inferred: 'inferred',
})

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Deterministic JSON (sorted keys at every depth, undefined dropped, Date -> ISO). */
function canonicalJson(value) {
  const normalize = (input) => {
    if (input === undefined) return null
    if (input instanceof Date) return input.toISOString()
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
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function round4(value) {
  const rounded = Math.round(value * 1e4) / 1e4
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Single-line, terminal-safe text (statements/ids/scopes are user data). */
function oneLine(value, field) {
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(String(value ?? ''))), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) throw new TypeError('profile ' + field + ' is empty')
  return text
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new TypeError('profile ' + field + ' must be a string when present')
  const text = oneLine(value, field)
  return text
}

function normalizeScope(raw, index) {
  if (!isPlainObject(raw)) throw new TypeError('profile preference ' + index + ' scope must be an object')
  const level = oneLine(raw.level, 'preference ' + index + ' scope.level')
  const scope = { level }
  if (raw.value !== undefined && raw.value !== null) scope.value = oneLine(raw.value, 'preference ' + index + ' scope.value')
  return scope
}

function authorityOf(row) {
  const type = isPlainObject(row.source) ? row.source.type : undefined
  return typeof type === 'string' && Object.hasOwn(PROFILE_AUTHORITY_BY_SOURCE, type)
    ? PROFILE_AUTHORITY_BY_SOURCE[type]
    : null
}

function normalizeNow(value) {
  if (value === undefined || value === null) return Date.now()
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw new TypeError('profile now must be a valid date/ISO string')
  return date.getTime()
}

function decayProjection(row, nowMs) {
  const stored = row.confidence
  const exempt = row.priority === 'hard' || row.status === 'deprecated'
  const from = row.lastConfirmed != null ? 'lastConfirmed' : row.validFrom != null ? 'validFrom' : null
  const base = from === null ? Number.NaN : Date.parse(row[from])
  if (!Number.isFinite(base)) {
    return { decayedConfidence: round4(stored), decayPeriods: 0, decayExempt: exempt, decayFrom: null }
  }
  const ageDays = (nowMs - base) / 86_400_000
  const periods = ageDays >= PROFILE_DECAY.windowDays ? Math.floor(ageDays / PROFILE_DECAY.windowDays) : 0
  const decayed = exempt ? stored : Math.max(0, stored * Math.pow(PROFILE_DECAY.factor, periods))
  return { decayedConfidence: round4(decayed), decayPeriods: exempt ? 0 : periods, decayExempt: exempt, decayFrom: from }
}

function compareCodepoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function scopeRank(scope) {
  const index = PROFILE_SCOPE_LEVELS.indexOf(scope.level)
  return index === -1 ? PROFILE_SCOPE_LEVELS.length : index
}

const PRIORITY_RANK = Object.freeze({ hard: 0, soft: 1 })

/**
 * Build the deterministic read-only profile payload.
 *
 * @param {object[]} [preferences] mapped preference rows (undefined/null = empty)
 * @param {{now?: Date|string}} [options] decay clock (not emitted)
 * @returns {{ok: true, mode: 'profile', profileVersion: number,
 *            source: 'preferences', count: number, groups: object[],
 *            dataSha256: string}}
 */
export function buildProfile(preferences, options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const nowMs = normalizeNow(opts.now)
  const rows = preferences === undefined || preferences === null ? [] : preferences
  if (!Array.isArray(rows)) throw new TypeError('profile preferences must be an array')
  const groups = new Map()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (!isPlainObject(row)) throw new TypeError('profile preference ' + index + ' must be an object')
    const id = oneLine(row.id, 'preference ' + index + ' id')
    const kind = oneLine(row.kind, 'preference ' + index + ' kind')
    const statement = oneLine(row.statement, 'preference ' + index + ' statement')
    const scope = normalizeScope(row.scope, index)
    if (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence)) {
      throw new TypeError('profile preference ' + index + ' confidence must be a finite number')
    }
    const status = oneLine(row.status, 'preference ' + index + ' status')
    const priority = oneLine(row.priority, 'preference ' + index + ' priority')
    const validFrom = optionalText(row.validFrom, 'preference ' + index + ' validFrom')
    const lastConfirmed = optionalText(row.lastConfirmed, 'preference ' + index + ' lastConfirmed')
    const expiresAt = optionalText(row.expiresAt, 'preference ' + index + ' expiresAt')
    const evidenceCount = Array.isArray(row.evidence) ? row.evidence.length : 0
    const authority = authorityOf(row)
    const projection = decayProjection({
      confidence: row.confidence,
      priority,
      status,
      validFrom,
      lastConfirmed,
    }, nowMs)
    const content = {
      id,
      kind,
      statement,
      scope,
      authority,
      status,
      priority,
      confidence: row.confidence,
      validFrom,
      lastConfirmed,
      expiresAt,
      evidenceCount,
    }
    const item = {
      ...content,
      ...projection,
      dataSha256: sha256Hex(canonicalJson(content)),
    }
    const groupKey = canonicalJson({ scope, kind })
    let group = groups.get(groupKey)
    if (!group) {
      group = { scope, kind, count: 0, preferences: [] }
      groups.set(groupKey, group)
    }
    group.preferences.push(item)
    group.count = group.preferences.length
  }
  const ordered = [...groups.values()].sort((left, right) => {
    const byScope = scopeRank(left.scope) - scopeRank(right.scope) ||
      compareCodepoint(left.scope.value ?? '', right.scope.value ?? '')
    if (byScope !== 0) return byScope
    return compareCodepoint(left.kind, right.kind)
  })
  for (const group of ordered) {
    group.preferences.sort((left, right) => {
      const byPriority = (PRIORITY_RANK[left.priority] ?? 2) - (PRIORITY_RANK[right.priority] ?? 2)
      if (byPriority !== 0) return byPriority
      const leftAt = left.lastConfirmed ?? left.validFrom ?? ''
      const rightAt = right.lastConfirmed ?? right.validFrom ?? ''
      const byTime = compareCodepoint(rightAt, leftAt)
      if (byTime !== 0) return byTime
      return compareCodepoint(left.id, right.id)
    })
  }
  const count = ordered.reduce((sum, group) => sum + group.count, 0)
  const body = { profileVersion: PROFILE_VERSION, source: PROFILE_SOURCE, count, groups: ordered }
  return {
    ok: true,
    mode: 'profile',
    profileVersion: PROFILE_VERSION,
    source: PROFILE_SOURCE,
    count,
    groups: ordered,
    dataSha256: sha256Hex(canonicalJson(body)),
  }
}

function scopeLabel(scope) {
  return scope.value === undefined ? scope.level : scope.level + ':' + scope.value
}

function decayLabel(item) {
  if (item.decayExempt) {
    if (item.priority === 'hard') return 'hard（不衰减）'
    if (item.status === 'deprecated') return 'deprecated（不衰减）'
    return '不衰减'
  }
  if (item.decayFrom === null) return '未知（无有效日期）'
  if (item.decayPeriods === 0) return '0×30d'
  return item.decayPeriods + '×30d'
}

function checkProfile(profile) {
  if (!isPlainObject(profile) || profile.mode !== 'profile' || !Array.isArray(profile.groups)) {
    throw new TypeError('renderProfileMarkdown requires a payload from buildProfile')
  }
  if (typeof profile.dataSha256 !== 'string' || !SHA256_HEX_RE.test(profile.dataSha256)) {
    throw new TypeError('profile dataSha256 is malformed')
  }
}

/**
 * Deterministic Markdown export of a profile payload (`profile export --md`).
 * Empty tables render a stable, explicit empty card (never a blank file).
 */
export function renderProfileMarkdown(profile) {
  checkProfile(profile)
  const lines = [
    '# 个人模型 · profile v' + profile.profileVersion,
    '',
    '> 只读视图：来自 `preferences` 表；不写库、不联网、零模型。未测量/未确认的内容按原状态显示，不冒充已知。',
    '',
    '- 条目：' + profile.count + ' · 分组：' + profile.groups.length + ' · dataSha256 `' + profile.dataSha256 + '`',
  ]
  if (profile.count === 0) {
    lines.push('', '（空：还没有偏好记录）')
    return lines.join('\n') + '\n'
  }
  for (const group of profile.groups) {
    lines.push('', '## ' + scopeLabel(group.scope) + ' · ' + group.kind + '（' + group.count + '）', '')
    for (const item of group.preferences) {
      const badge = [item.status, item.priority, item.authority ?? 'authority-unknown'].join(' · ')
      lines.push('- [' + badge + '] ' + item.statement)
      const detail = [
        'id `' + item.id + '`',
        'confidence ' + item.confidence.toFixed(2) + ' → ' + item.decayedConfidence.toFixed(2),
        'decay ' + decayLabel(item),
        'lastConfirmed ' + (item.lastConfirmed ?? '—'),
        'dataSha256 `' + item.dataSha256 + '`',
      ]
      if (item.expiresAt !== null) detail.splice(4, 0, 'expiresAt ' + item.expiresAt)
      lines.push('  - ' + detail.join(' · '))
    }
  }
  return lines.join('\n') + '\n'
}

export default Object.freeze({
  PROFILE_VERSION,
  PROFILE_SOURCE,
  PROFILE_SCOPE_LEVELS,
  PROFILE_DECAY,
  PROFILE_AUTHORITY_BY_SOURCE,
  buildProfile,
  renderProfileMarkdown,
})
