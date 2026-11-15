import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { readLedgerSnapshotReadOnly } from '../lib/pet-brief-store.js'
import {
  PET_BRIEF_MAX_ITEMS,
  PET_BRIEF_MIN_CONFIDENCE,
  PET_BRIEF_TTL_MS,
  buildPetBrief,
  validatePetBrief,
  writePetBriefAtomic,
} from '../lib/pet-brief.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const NOW = '2026-11-15T10:00:00+08:00'
const NOW_MS = Date.parse(NOW)

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
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra },
  })
}

function runRaw(home, args, cwd, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra },
  })
}

// ---------------------------------------------------------------------------
// producer projection
// ---------------------------------------------------------------------------

test('pet-brief: valid projection satisfies the contract and TTL', () => {
  const result = buildPetBrief(fixture().ledger, { now: NOW_MS })
  const checked = validatePetBrief(result, { now: NOW_MS })
  assert.deepEqual(checked.errors, [])
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.source, 'advisers')
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
    ['unknown schema', (() => { const b = clone(); b.schemaVersion = 2; return b })(), 'E_SCHEMA_VERSION'],
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
// atomic file write
// ---------------------------------------------------------------------------

test('pet-brief: --out writer is atomic, parses back, and is mode 600', () => {
  const { root, work } = setupStore()
  try {
    const brief = buildPetBrief(fixture().ledger, { now: NOW_MS })
    const target = join(work, 'nested', 'pet-brief.json')
    assert.equal(writePetBriefAtomic(target, brief), target)
    const mode = statSync(target).mode & 0o777
    assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`)
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
    assert.equal(statSync(target).mode & 0o777, 0o600)
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

test('pet-brief CLI: missing store exits non-zero with a machine-readable error', () => {
  const { root, home, work } = setupStore()
  try {
    const result = runRaw(home, ['pet-brief', '--json'], work)
    assert.equal(result.status, 1)
    // Node 22 (CI) emits an ExperimentalWarning for node:sqlite on stderr before
    // the machine-readable error; parse the final JSON line, not the whole stream.
    const errorLines = result.stderr.trim().split(/\r?\n/).filter(Boolean)
    const payload = JSON.parse(errorLines.at(-1))
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
