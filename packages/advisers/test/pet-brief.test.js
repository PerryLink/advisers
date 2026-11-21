import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertPrivateMode } from './win-compat.mjs'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { readLedgerSnapshotReadOnly } from '../lib/pet-brief-store.js'
import {
  PET_BRIEF_DEFAULT_DISPLAY_POLICY,
  PET_BRIEF_DISPLAY_POLICIES,
  PET_BRIEF_LEGACY_SCHEMA_VERSION,
  PET_BRIEF_MAX_ITEMS,
  PET_BRIEF_MAX_LINE_LENGTH,
  PET_BRIEF_MAX_SUGGESTED_LINES,
  PET_BRIEF_MIN_CONFIDENCE,
  PET_BRIEF_MOODS,
  PET_BRIEF_SCHEMA_VERSION,
  PET_BRIEF_SCHEMA_VERSIONS,
  PET_BRIEF_TTL_MS,
  buildPetBrief,
  validatePetBrief,
  writePetBriefAtomic,
} from '../lib/pet-brief.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const NOW = '2026-11-15T10:00:00+08:00'
const NOW_MS = Date.parse(NOW)
/** Public contract snapshot lives in the repo docs/ directory (not shipped in the npm tarball). */
const contractDir = fileURLToPath(new URL('../../../docs/pet-brief/', import.meta.url))
const contractJson = (name) => JSON.parse(readFileSync(join(contractDir, name), 'utf8'))
/** Inside the example/testcases TTL (generatedAt 09:00, expiresAt 09:05 +08:00). */
const CONTRACT_NOW = Date.parse('2026-11-17T09:02:00+08:00')

function fixture(options = {}) {
  const ledger = new Ledger()
  const client = ledger.addMatter({ title: '给王工发报价', participants: ['王工'] })
  const secret = ledger.addMatter({ title: '秘密并购', secrecy: 3 })
  const add = (matterId, action, dueAt, extra = {}) => ledger.addCommitment({
    matterId,
    debtor: 'user',
    creditor: '王工',
    action,
    dueAt,
    evidence: [{ sessionId: 'session_1', turnId: 'turn_1', quote: '机密原话-不应出现' }],
    ...extra,
  })
  const commitments = {
    today: add(client.id, '发报价', '2026-11-15T18:00:00+08:00'),
    overdue: add(client.id, '回邮件', '2026-11-14T09:00:00+08:00'),
    future: add(client.id, '整理周会纪要', '2026-11-20T09:00:00+08:00', { creditor: '团队' }),
    secret: add(secret.id, '秘密动作', '2026-11-15T12:00:00+08:00'),
  }
  ledger.remember({ matterId: client.id, subject: '王工', predicate: 'prefers', object: 'PDF 报价', confidence: 0.9 })
  ledger.remember({ matterId: client.id, subject: '公司', predicate: 'located_in', object: '上海', confidence: 0.7 })
  ledger.remember({ matterId: client.id, subject: '低置信对象', predicate: 'note', object: '低置信内容', confidence: 0.4 })
  ledger.remember({ matterId: secret.id, subject: '秘密联系人', predicate: 'note', object: '秘密事实', confidence: 0.99 })
  const excluded = options.excluded ?? 0
  for (let i = 0; i < excluded; i++) {
    const matter = ledger.addMatter({ title: `填充事项 ${i}`, secrecy: i % 3 === 0 ? 2 : 0 })
    if (i % 2 === 0) {
      add(matter.id, `填充承诺 ${i}a`, `2026-11-${String(1 + (i % 9)).padStart(2, '0')}T09:00:00+08:00`)
      add(matter.id, `填充承诺 ${i}b`, `2026-11-${String(2 + (i % 9)).padStart(2, '0')}T09:00:00+08:00`)
    }
    ledger.remember({ matterId: matter.id, subject: `对象${i}`, predicate: 'note', object: `事实${i}`, confidence: 0.8 })
  }
  return { ledger, client, secret, commitments }
}

function build(fixtureResult, options = {}) {
  return buildPetBrief(fixtureResult.ledger, { now: NOW_MS, ...options })
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function recursiveKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((entry) => recursiveKeys(entry, out))
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { out.push(key); recursiveKeys(entry, out) }
  return out
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => allStrings(entry, out))
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) allStrings(entry, out)
  return out
}

/** A suggested line is traceable when it reuses a >=2-char run from a brief field. */
function traceable(line, brief) {
  const sources = allStrings({
    today: brief.today.map((item) => item.title),
    commitments: brief.commitments.flatMap((item) => [item.who, item.what]),
    risks: brief.risks.map((item) => item.summary),
    facts: brief.facts.flatMap((item) => [item.subject, item.predicate, item.value]),
  })
  for (const source of sources) {
    const chars = Array.from(source)
    for (let size = chars.length; size >= 2; size--) {
      for (let start = 0; start + size <= chars.length; start++) {
        if (line.includes(chars.slice(start, start + size).join(''))) return true
      }
    }
  }
  return false
}

function setupStore() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-pet-brief-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

function writeSqliteFixture(home, ledger) {
  const store = new SqliteStore(join(home, 'state.db'))
  store.save(ledger.toJSON())
  store.close()
}

function run(home, args, cwd, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra }),
  })
}

function runRaw(home, args, cwd, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra }),
  })
}

/** Machine-readable CLI failures print one JSON object on stderr (after any Node warnings). */
function errorPayload(result) {
  const line = result.stderr.trim().split(/\r?\n/).filter(Boolean).find((entry) => entry.trim().startsWith('{'))
  assert.ok(line, result.stderr)
  return JSON.parse(line)
}

// ---------------------------------------------------------------------------
// producer projection
// ---------------------------------------------------------------------------

test('pet-brief: valid projection satisfies the contract and TTL', () => {
  const result = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const checked = validatePetBrief(result, { now: NOW_MS })
  assert.deepEqual(checked.errors, [])
  assert.deepEqual(checked.warnings, [])
  assert.equal(result.schemaVersion, 2)
  assert.equal(result.source, 'advisers')
  assert.equal(result.displayPolicy, 'private', 'displayPolicy must default to private')
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.generatedAt), PET_BRIEF_TTL_MS)
  assert.ok(['calm', 'focused', 'concerned', 'pleased'].includes(result.mood))
  assert.ok(result.counts.today <= PET_BRIEF_MAX_ITEMS)
  assert.ok(result.suggestedLines.length <= 3)
  for (const line of result.suggestedLines) assert.ok(Array.from(line).length <= 40, line)
  for (const [section, items] of Object.entries({ today: result.today, commitments: result.commitments, risks: result.risks, facts: result.facts })) {
    assert.ok(items.length <= PET_BRIEF_MAX_ITEMS, section)
    assert.equal(result.counts[section], items.length, section)
  }
})

test('pet-brief: client names are redacted and evidence quotes never leave', () => {
  const result = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('王工'), 'creditor name must be masked')
  assert.ok(!serialized.includes('秘密联系人'), 'secret matter participant must not leak')
  assert.ok(!serialized.includes('机密原话'), 'commitment evidence quote must not leak')
  assert.ok(!serialized.includes('秘密并购'), 'secret matter title must not leak')
  assert.match(serialized, /某客户/)
  assert.ok(result.redactions.some((note) => note.includes('脱敏')))
  assert.ok(result.redactions.some((note) => note.includes('正文')))
})

test('pet-brief: secrecy >= 2 matters are excluded entirely', () => {
  const result = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const ids = [
    ...result.today.map((item) => item.id),
    ...result.commitments.map((item) => item.matter),
    ...result.risks.map((item) => item.evidence),
    ...result.facts.map((item) => item.subject),
  ]
  assert.ok(!ids.includes('秘密动作'))
  assert.ok(!result.commitments.some((item) => item.what === '秘密动作'))
  assert.ok(!result.facts.some((item) => item.value === '秘密事实'))
  assert.ok(result.redactions.some((note) => note.includes('保密等级')))
})

test('pet-brief: confidence below 0.7 is omitted, boundary 0.7 is kept', () => {
  const { ledger } = fixture()
  const brief = buildPetBrief(ledger, { now: NOW_MS })
  assert.ok(!brief.facts.some((fact) => fact.value === '低置信内容'))
  assert.ok(!brief.facts.some((fact) => fact.value === '秘密事实'))
  assert.ok(brief.facts.some((fact) => fact.value === '上海'))
  assert.equal(PET_BRIEF_MIN_CONFIDENCE, 0.7)
  const strict = buildPetBrief(ledger, { now: NOW_MS, minConfidence: 0.95 })
  assert.ok(!strict.facts.some((fact) => fact.value === 'PDF 报价'))
  for (const fact of strict.facts) assert.ok(fact.confidence >= 0.95)
})

test('pet-brief: sections are capped at 10 items and risk ordering is deterministic', () => {
  const { ledger } = fixture({ excluded: 15 })
  const brief = buildPetBrief(ledger, { now: NOW_MS })
  assert.equal(brief.today.length, PET_BRIEF_MAX_ITEMS)
  assert.equal(brief.commitments.length, PET_BRIEF_MAX_ITEMS)
  assert.equal(brief.risks.length, PET_BRIEF_MAX_ITEMS)
  assert.equal(brief.facts.length, PET_BRIEF_MAX_ITEMS)
  assert.deepEqual(brief.counts, { today: 10, commitments: 10, risks: 10, facts: 10 })
  const firstRisk = brief.risks[0]
  assert.equal(firstRisk.level, 'high')
  assert.ok(brief.commitments.some((item) => item.id === firstRisk.evidence))
  for (const risk of brief.risks) assert.ok(risk.confidence >= 0.7)
})

test('pet-brief: deterministic output for the same ledger and now', () => {
  const { ledger } = fixture({ excluded: 3 })
  assert.equal(JSON.stringify(buildPetBrief(ledger, { now: NOW_MS })), JSON.stringify(buildPetBrief(ledger, { now: NOW_MS })))
})

test('pet-brief: empty ledger is valid (idle, no invented memory)', () => {
  const brief = buildPetBrief(new Ledger(), { now: NOW_MS })
  assert.deepEqual(brief.counts, { today: 0, commitments: 0, risks: 0, facts: 0 })
  assert.deepEqual(brief.today, [])
  assert.deepEqual(brief.commitments, [])
  assert.deepEqual(brief.risks, [])
  assert.deepEqual(brief.facts, [])
  assert.deepEqual(brief.suggestedLines, [])
  assert.equal(brief.mood, 'calm')
  assert.equal(validatePetBrief(brief, { now: NOW_MS }).ok, true)
})

test('pet-brief: output has no forbidden or emotional fields', () => {
  const result = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const forbidden = [/reasoning/i, /chain.?of.?thought/i, /raw.?prompt/i, /system.?prompt/i, /api.?key/i, /client.?secret/i, /password/i, /affection/i, /missed.?you/i, /streak/i, /guilt/i]
  for (const key of recursiveKeys(result)) assert.ok(!forbidden.some((pattern) => pattern.test(key)), `forbidden key: ${key}`)
})

test('pet-brief: suggested lines are short and traceable to brief fields', () => {
  const result = buildPetBrief(fixture().ledger, { now: NOW_MS })
  assert.ok(result.suggestedLines.length > 0)
  assert.ok(result.suggestedLines.length <= 3)
  for (const line of result.suggestedLines) {
    assert.ok(Array.from(line).length <= 40, line)
    assert.ok(traceable(line, result), `line is not traceable: ${line}`)
  }
})

// ---------------------------------------------------------------------------
// producer validator (contract vectors)
// ---------------------------------------------------------------------------

test('pet-brief validate: rejects bad schema/version/time/fields/counts/ids', () => {
  const base = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const clone = () => JSON.parse(JSON.stringify(base))
  const cases = [
    ['malformed JSON', '{"', 'E_MALFORMED_JSON'],
    ['unknown schema', (() => { const b = clone(); b.schemaVersion = 3; return b })(), 'E_SCHEMA_VERSION'],
    ['forbidden reasoning', (() => { const b = clone(); b.reasoning = 'hidden'; return b })(), 'E_FORBIDDEN_FIELD'],
    ['forbidden api_key', (() => { const b = clone(); b.api_key = 'sk-test'; return b })(), 'E_FORBIDDEN_FIELD'],
    ['expired', (() => { const b = clone(); b.generatedAt = '2020-01-01T00:00:00+08:00'; b.expiresAt = '2020-01-01T00:05:00+08:00'; return b })(), 'E_EXPIRED'],
    ['missing timezone', (() => { const b = clone(); b.generatedAt = '2026-11-15T10:00:00'; return b })(), 'E_TIME_FORMAT'],
    ['expires == generated', (() => { const b = clone(); b.expiresAt = b.generatedAt; return b })(), 'E_TIME_ORDER'],
    ['invalid mood', (() => { const b = clone(); b.mood = 'happy'; return b })(), 'E_ENUM'],
    ['counts mismatch', (() => { const b = clone(); b.counts.commitments += 1; return b })(), 'E_COUNTS'],
    ['too many commitments', (() => {
      const b = clone()
      b.commitments = Array.from({ length: 11 }, (_, i) => ({ ...b.commitments[0], id: `c${i}` }))
      b.counts.commitments = 11
      return b
    })(), 'E_MAX_ITEMS'],
    ['duplicate ids', (() => {
      const b = clone()
      b.commitments = [b.commitments[0], { ...b.commitments[0] }]
      b.counts.commitments = 2
      return b
    })(), 'E_DUP_ID'],
    ['unknown field', (() => { const b = clone(); b.extra = true; return b })(), 'E_UNKNOWN_FIELD'],
  ]
  for (const [name, value, code] of cases) {
    const checked = validatePetBrief(value, { now: NOW_MS })
    assert.equal(checked.ok, false, name)
    assert.ok(checked.errors.some((error) => error.code === code), `${name}: ${JSON.stringify(checked.errors)}`)
  }
})

test('pet-brief validate: allows expired when explicitly requested (schema-only mode)', () => {
  const base = buildPetBrief(fixture().ledger, { now: NOW_MS })
  base.generatedAt = '2020-01-01T00:00:00+08:00'
  base.expiresAt = '2020-01-01T00:05:00+08:00'
  assert.equal(validatePetBrief(base, { now: NOW_MS }).ok, false)
  assert.equal(validatePetBrief(base, { now: NOW_MS, allowExpired: true }).ok, true)
})

test('pet-brief validate: schema-valid low-confidence item is accepted (consumer omits it)', () => {
  const base = buildPetBrief(fixture().ledger, { now: NOW_MS })
  base.facts[0].confidence = 0.69
  const checked = validatePetBrief(base, { now: NOW_MS })
  assert.equal(checked.ok, true, JSON.stringify(checked.errors))
})

// ---------------------------------------------------------------------------
// contract v0.2 — displayPolicy, legacy compatibility, public snapshot
// ---------------------------------------------------------------------------

test('pet-brief v0.2: producers emit schemaVersion 2 with displayPolicy private by default', () => {
  const { ledger } = fixture()
  const brief = buildPetBrief(ledger, { now: NOW_MS })
  assert.equal(PET_BRIEF_SCHEMA_VERSION, 2)
  assert.deepEqual(PET_BRIEF_SCHEMA_VERSIONS, [1, 2])
  assert.equal(brief.schemaVersion, PET_BRIEF_SCHEMA_VERSION)
  assert.equal(PET_BRIEF_DEFAULT_DISPLAY_POLICY, 'private')
  assert.equal(brief.displayPolicy, 'private')
  assert.deepEqual(validatePetBrief(brief, { now: NOW_MS }).warnings, [])
  for (const policy of PET_BRIEF_DISPLAY_POLICIES) {
    const built = buildPetBrief(ledger, { now: NOW_MS, displayPolicy: policy })
    assert.equal(built.displayPolicy, policy)
    assert.equal(validatePetBrief(built, { now: NOW_MS }).ok, true, policy)
  }
  assert.throws(() => buildPetBrief(ledger, { now: NOW_MS, displayPolicy: 'audience' }), TypeError)
})

test('pet-brief v0.2: invalid displayPolicy is rejected, missing is a warning by default', () => {
  const base = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const invalid = validatePetBrief({ ...base, displayPolicy: 'audience' }, { now: NOW_MS })
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.some((error) => error.code === 'E_ENUM' && error.path === '$.displayPolicy'), JSON.stringify(invalid.errors))

  const missing = { ...base }
  delete missing.displayPolicy
  const lenient = validatePetBrief(missing, { now: NOW_MS })
  assert.equal(lenient.ok, true, JSON.stringify(lenient.errors))
  assert.ok(lenient.warnings.some((warning) => warning.code === 'W_MISSING_DISPLAY_POLICY'))

  const strict = validatePetBrief(missing, { now: NOW_MS, requireDisplayPolicy: true })
  assert.equal(strict.ok, false)
  assert.ok(strict.errors.some((error) => error.code === 'E_DISPLAY_POLICY'))
})

test('pet-brief v0.2: legacy v0.1 briefs are accepted with warnings, unknown versions fail closed', () => {
  const base = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const legacy = { ...base, schemaVersion: PET_BRIEF_LEGACY_SCHEMA_VERSION }
  delete legacy.displayPolicy
  const checked = validatePetBrief(legacy, { now: NOW_MS })
  assert.equal(checked.ok, true, JSON.stringify(checked.errors))
  const codes = checked.warnings.map((warning) => warning.code)
  assert.ok(codes.includes('W_LEGACY_SCHEMA_VERSION'), JSON.stringify(codes))
  assert.ok(codes.includes('W_MISSING_DISPLAY_POLICY'), JSON.stringify(codes))
  assert.deepEqual(checked.brief, legacy, 'validation must not rewrite the document')

  const strict = validatePetBrief(legacy, { now: NOW_MS, acceptLegacy: false })
  assert.equal(strict.ok, false)
  assert.ok(strict.errors.some((error) => error.code === 'E_SCHEMA_VERSION'))

  const future = validatePetBrief({ ...base, schemaVersion: 3 }, { now: NOW_MS })
  assert.equal(future.ok, false)
  assert.ok(future.errors.some((error) => error.code === 'E_SCHEMA_VERSION'))
})

test('pet-brief v0.2: public schema snapshot matches the implementation constants', () => {
  const schema = contractJson('schema-v0.2.json')
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.schemaVersion.const, PET_BRIEF_SCHEMA_VERSION)
  assert.ok(schema.required.includes('displayPolicy'))
  assert.deepEqual(schema.properties.displayPolicy.enum, PET_BRIEF_DISPLAY_POLICIES)
  assert.equal(schema.properties.displayPolicy.default, PET_BRIEF_DEFAULT_DISPLAY_POLICY)
  for (const section of ['today', 'commitments', 'risks', 'facts']) {
    assert.equal(schema.properties[section].maxItems, PET_BRIEF_MAX_ITEMS, section)
    assert.equal(schema.properties[section].items.additionalProperties, false, section)
  }
  for (const [name, property] of Object.entries(schema.properties.counts.properties)) {
    assert.equal(property.maximum, PET_BRIEF_MAX_ITEMS, name)
  }
  assert.equal(schema.properties.suggestedLines.maxItems, PET_BRIEF_MAX_SUGGESTED_LINES)
  assert.equal(schema.properties.suggestedLines.items.maxLength, PET_BRIEF_MAX_LINE_LENGTH)
  assert.deepEqual(schema.properties.mood.enum, PET_BRIEF_MOODS)
  assert.equal(schema.properties.redactions.maxItems, 10)
})

test('pet-brief v0.2: contract example is accepted by the producer validator', () => {
  const example = contractJson('example-v0.2.json')
  assert.equal(example.schemaVersion, PET_BRIEF_SCHEMA_VERSION)
  assert.equal(example.displayPolicy, 'private')
  const checked = validatePetBrief(example, { now: CONTRACT_NOW })
  assert.equal(checked.ok, true, JSON.stringify(checked.errors))
  assert.deepEqual(checked.warnings, [])
  assert.ok(example.redactions.length > 0)
  assert.ok(!JSON.stringify(example).includes('王工'), 'examples must stay synthetic/redacted')
})

test('pet-brief v0.2: contract test vectors behave as documented', () => {
  const vectors = contractJson('testcases-v0.2.json')
  assert.equal(vectors.contractVersion, 'v0.2')
  assert.equal(vectors.base.schemaVersion, PET_BRIEF_SCHEMA_VERSION)
  assert.equal(vectors.base.displayPolicy, 'private')
  assert.equal(vectors.cases.length, 26)
  const seen = new Set()
  for (const testCase of vectors.cases) {
    assert.ok(!seen.has(testCase.id), `duplicate vector id: ${testCase.id}`)
    seen.add(testCase.id)
    if (testCase.expect === 'skip') continue // consumer opt-out: no read; producer validator not applicable
    let input
    if (typeof testCase.raw === 'string') input = testCase.raw
    else {
      input = structuredClone(vectors.base)
      Object.assign(input, structuredClone(testCase.overrides ?? {}))
      for (const key of testCase.remove ?? []) delete input[key]
    }
    const checked = validatePetBrief(input, { now: CONTRACT_NOW })
    if (testCase.expect === 'reject') {
      assert.equal(checked.ok, false, `${testCase.id} should be rejected`)
      assert.ok(checked.errors.some((error) => error.code === testCase.errorCode), `${testCase.id}: expected ${testCase.errorCode}, got ${JSON.stringify(checked.errors)}`)
    } else {
      assert.equal(checked.ok, true, `${testCase.id}: ${JSON.stringify(checked.errors)}`)
      for (const code of testCase.warningCodes ?? []) {
        assert.ok(checked.warnings.some((warning) => warning.code === code), `${testCase.id}: missing warning ${code}`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// atomic file write
// ---------------------------------------------------------------------------

test('pet-brief: --out writer is atomic, parses back, and is mode 600', () => {
  const { root, work } = setupStore()
  try {
    const brief = buildPetBrief(fixture().ledger, { now: NOW_MS })
    const target = join(work, 'nested', 'pet-brief.json')
    assert.equal(writePetBriefAtomic(target, brief), target)
    assertPrivateMode(target, 0o600, 'pet-brief --out file')
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), JSON.parse(JSON.stringify(brief)))
    assert.deepEqual(readdirSync(join(work, 'nested')), ['pet-brief.json'], 'no temp file may survive')
    writePetBriefAtomic(target, { ...brief, mood: 'calm' })
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).mood, 'calm')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('pet-brief CLI: --json is a valid brief and the store is read-only', () => {
  const { root, home, work } = setupStore()
  try {
    const { ledger } = fixture()
    writeSqliteFixture(home, ledger)
    const db = join(home, 'state.db')
    const before = sha256(db)
    const out = run(home, ['pet-brief', '--json'], work)
    const brief = JSON.parse(out)
    assert.equal(brief.schemaVersion, PET_BRIEF_SCHEMA_VERSION)
    assert.equal(brief.displayPolicy, 'private')
    assert.equal(validatePetBrief(brief, { now: Date.now() }).ok, true)
    assert.ok(!out.includes('王工'), 'CLI JSON must not leak client names')
    assert.ok(!out.includes('机密原话'), 'CLI JSON must not leak evidence quotes')
    assert.equal(sha256(db), before, 'pet-brief must not modify the database')
    assert.equal(existsSync(join(home, 'pet-brief.json')), false, 'stdout mode must not write a file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: --out writes a 0600 brief atomically', () => {
  const { root, home, work } = setupStore()
  try {
    writeSqliteFixture(home, fixture().ledger)
    const target = join(work, 'pet-brief.json')
    const out = run(home, ['pet-brief', '--out', target], work)
    assert.match(out, /wrote /)
    assertPrivateMode(target, 0o600, 'pet-brief --out file')
    assert.equal(validatePetBrief(readFileSync(target, 'utf8'), { now: Date.now() }).ok, true)
    assert.deepEqual(readdirSync(work), ['pet-brief.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: --check passes on generated brief and rejects a tampered file', () => {
  const { root, home, work } = setupStore()
  try {
    writeSqliteFixture(home, fixture().ledger)
    const ok = JSON.parse(run(home, ['pet-brief', '--check'], work))
    assert.equal(ok.ok, true)
    const good = join(work, 'good.json')
    run(home, ['pet-brief', '--out', good], work)
    assert.equal(JSON.parse(run(home, ['pet-brief', '--check', '--in', good], work)).ok, true)

    const tampered = JSON.parse(readFileSync(good, 'utf8'))
    tampered.reasoning = 'hidden chain of thought'
    tampered.generatedAt = '2020-01-01T00:00:00+08:00'
    tampered.expiresAt = '2020-01-01T00:05:00+08:00'
    const bad = join(work, 'bad.json')
    writeFileSync(bad, JSON.stringify(tampered))
    const rejected = runRaw(home, ['pet-brief', '--check', '--in', bad], work)
    assert.equal(rejected.status, 1)
    const report = JSON.parse(rejected.stdout)
    assert.equal(report.ok, false)
    const codes = report.errors.map((error) => error.code)
    assert.ok(codes.includes('E_FORBIDDEN_FIELD'), JSON.stringify(codes))
    assert.ok(codes.includes('E_EXPIRED'), JSON.stringify(codes))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: --check accepts a legacy v0.1 brief (warnings never fail the check)', () => {
  const { root, home, work } = setupStore()
  try {
    writeSqliteFixture(home, fixture().ledger)
    const current = JSON.parse(run(home, ['pet-brief', '--json'], work))
    const legacy = { ...current, schemaVersion: PET_BRIEF_LEGACY_SCHEMA_VERSION }
    delete legacy.displayPolicy
    const legacyPath = join(work, 'legacy-v0.1.json')
    writeFileSync(legacyPath, JSON.stringify(legacy))
    const checked = runRaw(home, ['pet-brief', '--check', '--in', legacyPath], work)
    assert.equal(checked.status, 0, checked.stderr)
    const report = JSON.parse(checked.stdout)
    assert.equal(report.ok, true)
    assert.deepEqual(report.errors, [])
    const warningCodes = report.warnings.map((warning) => warning.code)
    assert.ok(warningCodes.includes('W_LEGACY_SCHEMA_VERSION'), JSON.stringify(warningCodes))
    assert.ok(warningCodes.includes('W_MISSING_DISPLAY_POLICY'), JSON.stringify(warningCodes))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: --display-policy passes through public/private/none and rejects unknown values', () => {
  const { root, home, work } = setupStore()
  try {
    writeSqliteFixture(home, fixture().ledger)
    const defaultBrief = JSON.parse(run(home, ['pet-brief', '--json'], work))
    assert.equal(defaultBrief.displayPolicy, PET_BRIEF_DEFAULT_DISPLAY_POLICY)
    for (const policy of PET_BRIEF_DISPLAY_POLICIES) {
      const brief = JSON.parse(run(home, ['pet-brief', '--json', '--display-policy', policy], work))
      assert.equal(brief.displayPolicy, policy)
      assert.equal(brief.schemaVersion, PET_BRIEF_SCHEMA_VERSION)
      assert.equal(validatePetBrief(brief, { now: Date.now() }).ok, true)
    }
    const invalid = runRaw(home, ['pet-brief', '--json', '--display-policy', 'audience'], work)
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stdout, '')
    assert.equal(errorPayload(invalid).error.code, 'E_USAGE')

    const good = join(work, 'good.json')
    run(home, ['pet-brief', '--out', good], work)
    const conflicting = runRaw(home, ['pet-brief', '--check', '--in', good, '--display-policy', 'public'], work)
    assert.equal(conflicting.status, 1)
    assert.equal(errorPayload(conflicting).error.code, 'E_USAGE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: --check reports warnings (exit unchanged) and --strict fails closed', () => {
  const { root, home, work } = setupStore()
  try {
    writeSqliteFixture(home, fixture().ledger)
    const generated = JSON.parse(run(home, ['pet-brief', '--check'], work))
    assert.equal(generated.ok, true)
    assert.deepEqual(generated.errors, [])
    assert.deepEqual(generated.warnings, [], 'a current v0.2 brief must have no warnings')

    const strictGenerated = runRaw(home, ['pet-brief', '--check', '--strict'], work)
    assert.equal(strictGenerated.status, 0, strictGenerated.stderr)
    assert.equal(JSON.parse(strictGenerated.stdout).ok, true)

    const legacy = JSON.parse(run(home, ['pet-brief', '--json'], work))
    legacy.schemaVersion = PET_BRIEF_LEGACY_SCHEMA_VERSION
    delete legacy.displayPolicy
    const legacyPath = join(work, 'legacy-strict.json')
    writeFileSync(legacyPath, JSON.stringify(legacy))

    const lenient = runRaw(home, ['pet-brief', '--check', '--in', legacyPath], work)
    assert.equal(lenient.status, 0, 'warnings must not change the exit code')
    const lenientCodes = JSON.parse(lenient.stdout).warnings.map((warning) => warning.code)
    assert.ok(lenientCodes.includes('W_LEGACY_SCHEMA_VERSION'), JSON.stringify(lenientCodes))
    assert.ok(lenientCodes.includes('W_MISSING_DISPLAY_POLICY'), JSON.stringify(lenientCodes))

    const strict = runRaw(home, ['pet-brief', '--check', '--in', legacyPath, '--strict'], work)
    assert.equal(strict.status, 1, '--strict must reject legacy briefs')
    const strictReport = JSON.parse(strict.stdout)
    assert.equal(strictReport.ok, false)
    const strictCodes = strictReport.errors.map((error) => error.code)
    assert.ok(strictCodes.includes('E_SCHEMA_VERSION'), JSON.stringify(strictCodes))
    assert.ok(strictCodes.includes('E_DISPLAY_POLICY'), JSON.stringify(strictCodes))

    const strictNoCheck = runRaw(home, ['pet-brief', '--strict'], work)
    assert.equal(strictNoCheck.status, 1)
    assert.equal(errorPayload(strictNoCheck).error.code, 'E_USAGE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: --print-schema prints the canonical v0.2 JSON Schema without a store', () => {
  const { root, home, work } = setupStore()
  try {
    const schema = JSON.parse(run(home, ['pet-brief', '--print-schema'], work))
    assert.deepEqual(schema, contractJson('schema-v0.2.json'), 'generated schema must equal the published snapshot')
    assert.equal(existsSync(join(home, 'state.db')), false, '--print-schema must not touch the store')
    const conflicting = runRaw(home, ['pet-brief', '--print-schema', '--json'], work)
    assert.equal(conflicting.status, 1)
    assert.equal(errorPayload(conflicting).error.code, 'E_USAGE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief CLI: missing store exits non-zero with a machine-readable error', () => {
  const { root, home, work } = setupStore()
  try {
    const result = runRaw(home, ['pet-brief', '--json'], work)
    assert.equal(result.status, 1)
    // Node 22 (CI) emits an ExperimentalWarning for node:sqlite on stderr before
    // the machine-readable error; parse the final JSON line, not the whole stream.
    const errorLines = result.stderr.trim().split(/\r?\n/).filter(Boolean)
    const jsonLine = errorLines.find((line) => line.trim().startsWith('{')) ?? errorLines.at(-1)
    const payload = JSON.parse(jsonLine)
    assert.equal(payload.error.code, 'E_STORE')
    assert.match(payload.error.message, /not found/)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pet-brief store: JSON loader is read-only and feeds the projection', () => {
  const { root, home, work } = setupStore()
  try {
    const ledger = fixture().ledger
    const statePath = join(home, 'state.json')
    writeFileSync(statePath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`)
    const before = sha256(statePath)
    const snapshot = readLedgerSnapshotReadOnly({ store: 'json', statePath, dbPath: join(home, 'state.db') })
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.matters.length, 2)
    assert.equal(sha256(statePath), before)
    assert.equal(buildPetBrief(Ledger.fromJSON(snapshot), { now: NOW_MS }).source, 'advisers')
    assert.throws(() => readLedgerSnapshotReadOnly({ store: 'json', statePath: join(work, 'missing.json') }), /not found/)
    assert.throws(() => readLedgerSnapshotReadOnly({ store: 'sqlite', dbPath: join(work, 'missing.db') }), /not found/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
