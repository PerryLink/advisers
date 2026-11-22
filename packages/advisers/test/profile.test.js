import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyPreferenceDecay } from '../lib/learning.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  PROFILE_AUTHORITY_BY_SOURCE,
  PROFILE_DECAY,
  PROFILE_SCOPE_LEVELS,
  PROFILE_SOURCE,
  PROFILE_VERSION,
  buildProfile,
  renderProfileMarkdown,
} from '../lib/profile.js'

// 043-3 read-only profile: grouping, derived authority/decay, dataSha256
// determinism, empty tables and the read-only guarantee. Every store test opens
// a throwaway SqliteStore under a mktemp directory; the real ~/.advisers is
// never touched and no test spawns the CLI or opens a socket.

const NOW = '2026-11-22T00:00:00.000Z'
const SHA256_RE = /^[0-9a-f]{64}$/

function pref(overrides) {
  return {
    id: 'pref_1',
    kind: 'preference',
    statement: '报价先发总额（不含税）',
    scope: { level: 'global' },
    source: { type: 'user_explicit' },
    evidence: [{ quote: '报价先发总额' }],
    confidence: 0.9,
    status: 'confirmed',
    validFrom: '2026-10-01T00:00:00.000Z',
    priority: 'soft',
    ...overrides,
  }
}

/** The fixed fixture: seven stored rows covering every scope and status branch. */
function fixture() {
  return [
    // user soft, lastConfirmed 52 days ago -> one 30-day decay period
    pref({ id: 'pref_global_user', lastConfirmed: '2026-10-01T00:00:00.000Z' }),
    // inferred candidate, 2 days old -> no decay period yet
    pref({ id: 'pref_global_inferred', kind: 'constraint', source: { type: 'inferred' }, status: 'candidate', validFrom: '2026-11-20T00:00:00.000Z' }),
    // imported hard taboo, 82 days old but hard -> decay exempt
    pref({ id: 'pref_matter_hard', kind: 'taboo', scope: { level: 'matter', value: 'm_acme' }, source: { type: 'imported' }, priority: 'hard', lastConfirmed: '2026-09-01T00:00:00.000Z' }),
    // tool soft preference, no lastConfirmed -> decay from validFrom, 325 days -> 10 periods
    pref({ id: 'pref_matter_old', kind: 'preference', scope: { level: 'matter', value: 'm_acme' }, source: { type: 'tool' }, validFrom: '2026-01-01T00:00:00.000Z', confidence: 0.9 }),
    // deprecated -> shown, decay exempt
    pref({ id: 'pref_project_deprecated', kind: 'goal', scope: { level: 'project', value: 'p_x' }, status: 'deprecated', confidence: 0.5, lastConfirmed: '2026-01-01T00:00:00.000Z' }),
    // audience preference with an explicit expiry and no lastConfirmed
    pref({ id: 'pref_audience_expiring', kind: 'relationship', scope: { level: 'audience', value: 'aud_1' }, validFrom: '2026-11-21T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }),
    // second hard taboo in the same group (ordering) + unknown source type
    pref({ id: 'pref_matter_hard_b', kind: 'taboo', scope: { level: 'matter', value: 'm_acme' }, source: { type: 'mystery' }, priority: 'hard', lastConfirmed: '2026-11-10T00:00:00.000Z' }),
  ]
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

function canonicalJson(value) {
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
    return input
  }
  return JSON.stringify(normalize(value))
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function groupLabel(group) {
  const label = group.scope.value === undefined ? group.scope.level : group.scope.level + ':' + group.scope.value
  return label + '/' + group.kind
}

function itemsById(profile) {
  return new Map(profile.groups.flatMap((group) => group.preferences).map((item) => [item.id, item]))
}

test('profile: groups by scope then kind and emits the documented per-item fields', () => {
  const profile = buildProfile(fixture(), { now: NOW })
  assert.equal(profile.ok, true)
  assert.equal(profile.mode, 'profile')
  assert.equal(profile.profileVersion, PROFILE_VERSION)
  assert.equal(profile.source, PROFILE_SOURCE)
  assert.equal(profile.count, 7)
  assert.deepEqual(profile.groups.map(groupLabel), [
    'global/constraint',
    'global/preference',
    'project:p_x/goal',
    'matter:m_acme/preference',
    'matter:m_acme/taboo',
    'audience:aud_1/relationship',
  ])
  assert.deepEqual(profile.groups.map((group) => group.count), [1, 1, 1, 1, 2, 1])
  assert.match(profile.dataSha256, SHA256_RE)
  const items = itemsById(profile)
  assert.equal(items.size, 7, 'every stored row appears exactly once')
  const user = items.get('pref_global_user')
  assert.equal(user.kind, 'preference')
  assert.deepEqual(user.scope, { level: 'global' })
  assert.equal(user.authority, 'user')
  assert.equal(user.status, 'confirmed')
  assert.equal(user.priority, 'soft')
  assert.equal(user.confidence, 0.9)
  assert.equal(user.decayedConfidence, 0.72, '52 days -> one 0.8 factor')
  assert.equal(user.decayPeriods, 1)
  assert.equal(user.decayExempt, false)
  assert.equal(user.decayFrom, 'lastConfirmed')
  assert.equal(user.lastConfirmed, '2026-10-01T00:00:00.000Z')
  assert.equal(user.validFrom, '2026-10-01T00:00:00.000Z')
  assert.equal(user.expiresAt, null)
  assert.equal(user.evidenceCount, 1)
  assert.equal(items.get('pref_global_inferred').authority, 'inferred')
  assert.equal(items.get('pref_matter_hard').authority, 'import')
  assert.equal(items.get('pref_matter_old').authority, 'tool')
  assert.equal(items.get('pref_matter_hard_b').authority, null, 'an unknown source type is not guessed')
  assert.equal(items.get('pref_global_inferred').decayedConfidence, 0.9, 'under 30 days has no decay period')
  assert.equal(items.get('pref_global_inferred').decayPeriods, 0)
  assert.equal(items.get('pref_matter_hard').decayExempt, true)
  assert.equal(items.get('pref_matter_hard').decayedConfidence, 0.9, 'hard priority is never decayed')
  assert.equal(items.get('pref_matter_hard').decayPeriods, 0)
  assert.equal(items.get('pref_matter_old').decayFrom, 'validFrom', 'decay falls back to validFrom')
  assert.equal(items.get('pref_matter_old').decayPeriods, 10)
  assert.equal(items.get('pref_matter_old').decayedConfidence, 0.0966)
  assert.equal(items.get('pref_project_deprecated').status, 'deprecated', 'deprecated rows stay visible')
  assert.equal(items.get('pref_project_deprecated').decayExempt, true)
  assert.equal(items.get('pref_audience_expiring').expiresAt, '2027-01-01T00:00:00.000Z')
  assert.equal(items.get('pref_audience_expiring').lastConfirmed, null)
})

test('profile: within a group hard precedes soft and newer confirmations come first', () => {
  const profile = buildProfile(fixture(), { now: NOW })
  const globalPrefs = profile.groups.find((group) => groupLabel(group) === 'global/preference')
  assert.deepEqual(globalPrefs.preferences.map((item) => item.id), ['pref_global_user'])
  const hard = profile.groups.find((group) => groupLabel(group) === 'matter:m_acme/taboo')
  assert.deepEqual(hard.preferences.map((item) => item.id), ['pref_matter_hard_b', 'pref_matter_hard'], 'newest hard first')
})

test('profile: every dataSha256 is recomputable from the visible fields only', () => {
  const profile = buildProfile(fixture(), { now: NOW })
  for (const item of itemsById(profile).values()) {
    const visible = {
      id: item.id,
      kind: item.kind,
      statement: item.statement,
      scope: item.scope,
      authority: item.authority,
      status: item.status,
      priority: item.priority,
      confidence: item.confidence,
      validFrom: item.validFrom,
      lastConfirmed: item.lastConfirmed,
      expiresAt: item.expiresAt,
      evidenceCount: item.evidenceCount,
    }
    assert.equal(item.dataSha256, sha256(canonicalJson(visible)), item.id + ' dataSha256 must verify from the payload alone')
  }
  const body = { profileVersion: profile.profileVersion, source: profile.source, count: profile.count, groups: profile.groups }
  assert.equal(profile.dataSha256, sha256(canonicalJson(body)), 'the export hash covers the visible export')
})

test('profile: two runs over the same rows are byte-identical and never mutate the input', () => {
  const rows = deepFreeze(fixture())
  const snapshot = JSON.parse(JSON.stringify(rows))
  const first = buildProfile(rows, { now: NOW })
  const second = buildProfile(rows, { now: NOW })
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(first.dataSha256, second.dataSha256)
  assert.deepEqual(rows, snapshot, 'the profile is a projection: the input rows are untouched')
  assert.equal(renderProfileMarkdown(first), renderProfileMarkdown(second))
})

test('profile: an empty table renders a stable explicit empty card', () => {
  const fromEmpty = buildProfile([], { now: NOW })
  assert.equal(fromEmpty.count, 0)
  assert.deepEqual(fromEmpty.groups, [])
  assert.match(fromEmpty.dataSha256, SHA256_RE)
  assert.deepEqual(buildProfile(undefined, { now: NOW }), fromEmpty)
  assert.deepEqual(buildProfile(null), fromEmpty, 'undefined/null preferences mean an empty table, not an error')
  const markdown = renderProfileMarkdown(fromEmpty)
  assert.equal(markdown, renderProfileMarkdown(fromEmpty))
  assert.ok(markdown.includes('# 个人模型 · profile v' + PROFILE_VERSION))
  assert.ok(markdown.includes('（空'), 'an empty profile says so instead of rendering a blank file')
  assert.ok(markdown.includes(fromEmpty.dataSha256))
  assert.ok(markdown.endsWith('\n'))
  assert.doesNotMatch(markdown, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/)
})

test('profile: markdown export carries the grouped rows and the decay story', () => {
  const profile = buildProfile(fixture(), { now: NOW })
  const markdown = renderProfileMarkdown(profile)
  assert.ok(markdown.includes('## global · preference（1）'))
  assert.ok(markdown.includes('报价先发总额（不含税）'))
  assert.ok(markdown.includes('confidence 0.90 → 0.72'))
  assert.ok(markdown.includes('decay 1×30d'))
  assert.ok(markdown.includes('dataSha256 `' + profile.dataSha256 + '`'), 'markdown shows the export hash')
  for (const item of itemsById(profile).values()) assert.ok(markdown.includes(item.id), item.id)
  assert.throws(() => renderProfileMarkdown(null), TypeError)
  assert.throws(() => renderProfileMarkdown({ mode: 'profile', groups: [], dataSha256: 'x' }), TypeError)
})

test('profile: invalid rows fail closed instead of rendering a misleading profile', () => {
  assert.throws(() => buildProfile('nope'), TypeError)
  assert.throws(() => buildProfile([{ id: 'x' }]), TypeError)
  assert.throws(() => buildProfile([pref({ confidence: '0.9' })]), TypeError)
  assert.throws(() => buildProfile([pref({ confidence: Number.NaN })]), TypeError)
  assert.throws(() => buildProfile([pref({ id: undefined })]), TypeError)
  assert.throws(() => buildProfile([pref({ statement: '  ' })]), TypeError)
  assert.throws(() => buildProfile([pref({ scope: { level: '' } })]), TypeError)
  assert.throws(() => buildProfile(fixture(), { now: 'not-a-date' }), TypeError)
})

test('profile: reads a real SQLite preferences table without writing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-profile-'))
  const store = new SqliteStore(join(root, 'state.db'))
  try {
    assert.deepEqual(store.loadPreferences(), [])
    assert.equal(buildProfile(store.loadPreferences(), { now: NOW }).count, 0)
    store.mutate(() => {
      store.insertPreference(pref({ id: 'pref_store_a', kind: 'preference', statement: '先给结论', scope: { level: 'global' } }))
      store.insertPreference(pref({ id: 'pref_store_b', kind: 'constraint', statement: '不夸大', scope: { level: 'global' }, source: { type: 'user_explicit' }, lastConfirmed: '2026-10-01T00:00:00.000Z' }))
    })
    const rows = store.loadPreferences()
    assert.equal(rows.length, 2)
    const beforeRows = JSON.stringify(rows)
    const auditBefore = store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n
    const profile = buildProfile(rows, { now: NOW })
    assert.equal(profile.count, 2)
    assert.equal(profile.groups.length, 2)
    assert.equal(JSON.stringify(store.loadPreferences()), beforeRows, 'the profile command must not write preferences')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, auditBefore, 'the profile command must not append audit rows')
    assert.deepEqual(buildProfile(store.loadPreferences(), { now: NOW }), profile, 'deterministic over the same table')
  } finally {
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('profile: decay projection uses the same 0.8/30d rule as lib/learning.js, without writing', () => {
  const rows = fixture()
  const profile = buildProfile(rows, { now: NOW })
  const items = itemsById(profile)
  const clones = rows.map((row) => ({ ...row, scope: { ...row.scope }, source: { ...row.source }, evidence: [...row.evidence] }))
  const changed = applyPreferenceDecay(clones, new Date(NOW))
  assert.deepEqual(changed.map((row) => row.id).sort(), ['pref_global_user', 'pref_matter_old'], 'the shared decay rule agrees on which rows move')
  for (const clone of clones) {
    const item = items.get(clone.id)
    assert.ok(item, clone.id + ' appears in the profile')
    const expected = Math.round(clone.confidence * 1e4) / 1e4
    assert.equal(item.decayedConfidence, expected, clone.id + ' projection must match applyPreferenceDecay')
  }
  assert.deepEqual(rows, fixture(), 'the cross-check cloned the rows: the original fixture is untouched')
})

test('profile: module surface and local-only imports', () => {
  assert.deepEqual(PROFILE_SCOPE_LEVELS, ['global', 'project', 'matter', 'audience'])
  assert.equal(PROFILE_DECAY.windowDays, 30)
  assert.equal(PROFILE_DECAY.factor, 0.8)
  assert.deepEqual(PROFILE_AUTHORITY_BY_SOURCE, { user_explicit: 'user', imported: 'import', tool: 'tool', inferred: 'inferred' })
  assert.ok(Object.isFrozen(PROFILE_SCOPE_LEVELS))
  assert.ok(Object.isFrozen(PROFILE_DECAY))
  const source = readFileSync(new URL('../lib/profile.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\s+[^\n]*?from\s+'([^']+)'/gm)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['./text-safe.js', 'node:crypto'], 'no store/model/network imports')
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dgram|child_process)/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream)\b/)
})
