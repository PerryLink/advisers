/**
 * Policy engine 0.4 subset: pure evaluate() facts -> decision.
 *
 * Covers R-P04-01..10, fail-closed malformed facts, determinism, the effect
 * digest, and the surface matrix. No HOME, no database, no network: evaluate()
 * takes facts by value, so every case is a pure table row.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  POLICY_CODES,
  POLICY_RULES,
  SURFACE_GATES,
  SURFACE_REGISTRY,
  canonicalFacts,
  effectDigestOf,
  evaluate,
  getSurface,
  normalizeSurface,
  surfaceMatrix,
  surfaceSupportsAction,
} from '../lib/policy/index.js'

function facts(overrides = {}) {
  return {
    surface: 'chat',
    action: 'model-egress',
    actor: 'cli',
    interactive: false,
    confirmed: false,
    tos: { accepted: true, version: '2026.11.3', currentVersion: '2026.11.3', hashOk: true },
    audit: { available: true },
    safety: { action: 'allow' },
    consent: null,
    trust: null,
    record: null,
    path: null,
    ...overrides,
  }
}

function assertDecision(result, decision, code) {
  assert.equal(result.decision, decision, JSON.stringify(result))
  if (code === null) assert.equal(result.code, null)
  else assert.equal(result.code, code, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
// shape / purity
// ---------------------------------------------------------------------------

test('evaluate returns a deterministic JSON-ready decision', () => {
  const input = facts()
  const first = evaluate(input)
  const second = evaluate({ ...input })
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'identical facts must produce identical bytes')
  assert.equal(first.v, 1)
  assert.equal(first.surface, 'chat')
  assert.equal(first.action, 'model-egress')
  assert.equal(first.decision, 'allow')
  assert.equal(first.code, null)
  assert.deepEqual(first.ruleIds, ['R-P04-10'])
  assert.ok(first.effectDigest.startsWith('sha256:'))
  assert.equal(JSON.parse(JSON.stringify(first)).decision, 'allow')
  // Changing the effect changes the digest, not the decision.
  assert.notEqual(evaluate(facts({ surface: 'capture' })).effectDigest, first.effectDigest)
})

test('the engine modules are pure data/JS: no fs, network or child_process imports', () => {
  for (const name of ['rules.js', 'surfaces.js', 'errors.js', 'egress.js']) {
    const source = readFileSync(new URL('../lib/policy/' + name, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'node:(fs|http|https|net|tls|child_process)'/, name)
    assert.doesNotMatch(source, /\bfetch\s*\(/, name)
    assert.doesNotMatch(source, /\bnew Function\b/, name)
  }
})

test('the rule catalogue is St stable and complete (R-P04-01..10)', () => {
  const ids = POLICY_RULES.map((rule) => rule.id)
  assert.deepEqual(ids, ['R-P04-00', 'R-P04-01', 'R-P04-02', 'R-P04-03', 'R-P04-04', 'R-P04-05', 'R-P04-06', 'R-P04-07', 'R-P04-08', 'R-P04-09', 'R-P04-10'])
})

// ---------------------------------------------------------------------------
// R-P04-01/02: registry + TOS
// ---------------------------------------------------------------------------

test('unknown surfaces and undeclared actions fail closed', () => {
  assertDecision(evaluate(facts({ surface: 'nope' })), 'deny', POLICY_CODES.POLICY_UNKNOWN_SURFACE.code)
  assert.equal(normalizeSurface('nope'), null)
  assertDecision(evaluate(facts({ surface: 'mcp', action: 'exec' })), 'deny', POLICY_CODES.POLICY_UNKNOWN_SURFACE.code)
  assert.equal(surfaceSupportsAction('mcp', 'read'), true)
  assert.equal(surfaceSupportsAction('mcp', 'exec'), false)
  assert.equal(getSurface('MCP').surface, 'mcp')
})

test('missing/changed TOS facts deny with E_TOS_REQUIRED (exit 3 stays)', () => {
  assertDecision(evaluate(facts({ tos: null })), 'deny', POLICY_CODES.POLICY_TOS_REQUIRED.code)
  assertDecision(evaluate(facts({ tos: { accepted: false } })), 'deny', POLICY_CODES.POLICY_TOS_REQUIRED.code)
  assertDecision(evaluate(facts({ tos: { accepted: true, version: 'old', currentVersion: 'new' } })), 'deny', POLICY_CODES.POLICY_TOS_REQUIRED.code)
  assertDecision(evaluate(facts({ tos: { accepted: true, hashOk: false } })), 'deny', POLICY_CODES.POLICY_TOS_REQUIRED.code)
  assert.equal(POLICY_CODES.POLICY_TOS_REQUIRED.exit, 3)
})

// ---------------------------------------------------------------------------
// R-P04-03/04: secrecy
// ---------------------------------------------------------------------------

test('egress from a protected matter is denied per record', () => {
  assertDecision(evaluate(facts({ record: { kind: 'commitment', secrecy: 1 } })), 'deny', POLICY_CODES.POLICY_SECRECY_BLOCKED.code)
  assertDecision(evaluate(facts({ record: { kind: 'commitment', secrecy: 3 } })), 'deny', POLICY_CODES.POLICY_SECRECY_BLOCKED.code)
  assertDecision(evaluate(facts({ record: { kind: 'commitment', secrecy: 0 } })), 'allow', null)
})

test('read/export respects per-record clearance and fails closed on bad facts', () => {
  const readFacts = facts({ surface: 'mcp', action: 'read', record: { kind: 'commitment', secrecy: 2 } })
  assertDecision(evaluate({ ...readFacts, clearance: 3 }), 'allow', null)
  assertDecision(evaluate({ ...readFacts, clearance: 1 }), 'deny', POLICY_CODES.POLICY_SECRECY_BLOCKED.code)
  // clearance above 4 is still allowed only when the record is within it
  assertDecision(evaluate({ ...readFacts, clearance: 4 }), 'allow', null)
  assertDecision(evaluate({ ...readFacts, clearance: -1 }), 'deny', POLICY_CODES.POLICY_INVALID_FACTS.code)
})

// ---------------------------------------------------------------------------
// R-P04-05: consent for mail/KB model egress
// ---------------------------------------------------------------------------

function mailFacts(overrides = {}) {
  return facts({ surface: 'mail.extract', action: 'model-egress', dataClass: 'mail', consent: null, ...overrides })
}

test('model egress of mail/KB content requires a matching consent record', () => {
  assertDecision(evaluate(mailFacts()), 'deny', POLICY_CODES.POLICY_CONSENT_REQUIRED.code)
  assertDecision(evaluate(mailFacts({ consent: { granted: true } })), 'deny', POLICY_CODES.POLICY_CONSENT_REQUIRED.code)
  // A consent record that does not name the provider cannot satisfy the rule.
  assertDecision(
    evaluate(mailFacts({ consent: { dataClass: 'mail', granted: true } })),
    'deny',
    POLICY_CODES.POLICY_CONSENT_REQUIRED.code,
  )
  assertDecision(
    evaluate(mailFacts({ consent: { dataClass: 'mail', provider: 'deepseek', granted: true } })),
    'allow',
    null,
    'surface is optional on consent facts; provider + dataClass + granted are the minimum',
  )
  const granted = { dataClass: 'mail', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', granted: true, surface: 'mail.extract' }
  const allowed = evaluate(mailFacts({ consent: granted }))
  assertDecision(allowed, 'allow', null)
  assert.deepEqual(allowed.obligations, ['audit.intent', 'audit.result', 'consent.record'])
  assertDecision(evaluate(mailFacts({ consent: { ...granted, dataClass: 'kb' } })), 'deny', POLICY_CODES.POLICY_CONSENT_REQUIRED.code)
  assertDecision(evaluate(mailFacts({ consent: { ...granted, surface: 'kb.ask' } })), 'deny', POLICY_CODES.POLICY_CONSENT_REQUIRED.code)
  assertDecision(evaluate(mailFacts({ consent: { ...granted, revokedAt: '2026-11-20T00:00:00.000Z' } })), 'deny', POLICY_CODES.POLICY_CONSENT_REQUIRED.code)
  // conversation egress is not gated by the mail/KB consent rule
  assertDecision(evaluate(facts()), 'allow', null)
})

test('kb.ask model egress is denied without a kb consent even when the surface is enabled', () => {
  const kbFacts = facts({ surface: 'kb.ask', action: 'model-egress', dataClass: 'kb' })
  assertDecision(evaluate(kbFacts), 'deny', POLICY_CODES.POLICY_CONSENT_REQUIRED.code)
  const allowed = evaluate(
    facts({
      surface: 'kb.ask',
      action: 'model-egress',
      dataClass: 'kb',
      consent: { dataClass: 'kb', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', granted: true, surface: 'kb.ask' },
    }),
  )
  assertDecision(allowed, 'allow', null)
})

// ---------------------------------------------------------------------------
// R-P04-06..09: taint, audit, path, safety
// ---------------------------------------------------------------------------

function writeFsFacts(overrides = {}) {
  return facts({ surface: 'agent', action: 'write-fs', dataClass: 'tool', path: 'workspace', safety: null, ...overrides })
}

test('tainted content driving fs/send/exec needs interactive confirmation', () => {
  const tainted = { tainted: true, sourceKinds: ['mail'] }
  assertDecision(evaluate(writeFsFacts({ trust: tainted, interactive: false })), 'deny', POLICY_CODES.POLICY_CONFIRMATION_UNAVAILABLE.code)
  const confirm = evaluate(writeFsFacts({ trust: tainted, interactive: true, confirmed: false }))
  assertDecision(confirm, 'confirm', POLICY_CODES.POLICY_CONFIRMATION_UNAVAILABLE.code)
  assert.deepEqual(confirm.obligations, ['confirm'])
  assertDecision(evaluate(writeFsFacts({ trust: tainted, interactive: true, confirmed: true })), 'allow', null)
  // Trusted content driving the same write is allowed without a confirmation.
  assertDecision(evaluate(writeFsFacts({ trust: { tainted: false } })), 'allow', null)
})

test('side effects fail closed when the audit channel is unavailable', () => {
  assertDecision(evaluate(writeFsFacts({ audit: null })), 'deny', POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code)
  assertDecision(evaluate(writeFsFacts({ audit: { available: false } })), 'deny', POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code)
  // Reads do not require an audit row.
  assertDecision(evaluate(facts({ surface: 'mcp', action: 'read', audit: null })), 'allow', null)
})

test('protected, persistence and escaping paths are denied (legacyCode preserved)', () => {
  const sensitive = evaluate(writeFsFacts({ path: { kind: 'sensitive', code: 'SENSITIVE_PATH' } }))
  assertDecision(sensitive, 'deny', POLICY_CODES.POLICY_PROTECTED_PATH.code)
  assert.equal(sensitive.legacyCode, undefined, 'details stay JSON-ready; legacyCode is on the rule hit not the top level')
  assertDecision(evaluate(writeFsFacts({ path: { kind: 'persistence', code: 'PERSISTENCE_WRITE' } })), 'deny', POLICY_CODES.POLICY_PROTECTED_PATH.code)
  assertDecision(evaluate(writeFsFacts({ path: { kind: 'outside', code: 'OUTSIDE_WORKSPACE' } })), 'deny', POLICY_CODES.POLICY_WORKSPACE_ESCAPE.code)
  assertDecision(evaluate(writeFsFacts({ path: { codde: 'SENSITIVE_PATH' } })), 'deny', POLICY_CODES.POLICY_INVALID_FACTS.code)
  assertDecision(evaluate(writeFsFacts({ path: null })), 'deny', POLICY_CODES.POLICY_INVALID_FACTS.code)
  assertDecision(evaluate(writeFsFacts({ path: 'weird' })), 'deny', POLICY_CODES.POLICY_INVALID_FACTS.code)
})

test('content safety blocks, and a missing verdict fails closed for content egress', () => {
  assertDecision(evaluate(facts({ safety: { action: 'block' } })), 'deny', POLICY_CODES.POLICY_CONTENT_SAFETY_BLOCKED.code)
  assertDecision(evaluate(facts({ safety: { action: 'blocked' } })), 'deny', POLICY_CODES.POLICY_CONTENT_SAFETY_BLOCKED.code)
  assertDecision(evaluate(facts({ safety: null })), 'deny', POLICY_CODES.POLICY_SAFETY_REQUIRED.code)
  assertDecision(evaluate(facts({ safety: { action: 'review' } })), 'deny', POLICY_CODES.POLICY_SAFETY_REQUIRED.code)
  assertDecision(evaluate(writeFsFacts({ safety: null })), 'allow', null)
})

// ---------------------------------------------------------------------------
// malformed facts + digest
// ---------------------------------------------------------------------------

test('malformed facts deny instead of throwing', () => {
  for (const input of [null, undefined, [], 'facts', 42, { action: 'read' }, { surface: 'mcp' }, { surface: 5, action: 'read' }]) {
    const result = evaluate(input)
    assert.equal(result.decision, 'deny', JSON.stringify(input))
    assert.equal(result.code, POLICY_CODES.POLICY_INVALID_FACTS.code, JSON.stringify(input))
    assert.deepEqual(result.ruleIds, ['R-P04-00'])
  }
  assert.equal(canonicalFacts({ surface: 'chat', action: 'model-egress', v: 2 }).ok, false)
  assert.equal(canonicalFacts({ surface: 'chat', action: 'model-egress', tos: 'yes' }).ok, false)
  assert.equal(canonicalFacts({ surface: 'chat', action: 'model-egress', consent: [] }).ok, false)
})

test('effectDigest binds the effect metadata and ignores unrelated keys', () => {
  const base = { surface: 'mail.extract', action: 'model-egress', dataClass: 'mail', provider: 'deepseek', path: 'workspace', record: { kind: 'commitment', secrecy: 0 } }
  const first = effectDigestOf(base)
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
  assert.equal(effectDigestOf({ ...base }), first)
  assert.equal(effectDigestOf({ ...base, unrelated: 'ignore me' }), first)
  assert.notEqual(effectDigestOf({ ...base, recipient: 'a@example.com' }), first)
  assert.notEqual(effectDigestOf({ ...base, provider: 'other' }), first)
  assert.notEqual(effectDigestOf({ ...base, dataClass: 'kb' }), first)
  assert.notEqual(effectDigestOf({ ...base, record: { kind: 'commitment', secrecy: 1 } }), first)
  assert.notEqual(effectDigestOf({ ...base, path: 'outside' }), first)
})

test('decisions never echo user content (recipient/subject/path text)', () => {
  const result = evaluate(
    facts({
      path: { kind: 'workspace', label: 'C:/Users/secret/project' },
      recipient: 'wang@example.com',
      subject: '客户并购案',
      record: { kind: 'commitment', secrecy: 0, title: '内部标题' },
    }),
  )
  const text = JSON.stringify(result)
  for (const needle of ['C:/Users/secret/project', 'wang@example.com', '客户并购案', '内部标题']) {
    assert.equal(text.includes(needle), false, needle + ' must not be echoed')
  }
})

// ---------------------------------------------------------------------------
// surface matrix
// ---------------------------------------------------------------------------

test('surface matrix is generated from the registry and honest about gates/defaults', () => {
  const matrix = surfaceMatrix()
  assert.equal(matrix.rows.length, SURFACE_REGISTRY.length)
  assert.ok(matrix.rows.length >= 12)
  for (const row of matrix.rows) {
    assert.ok(SURFACE_GATES.includes(row.gate), row.surface + ' gate ' + row.gate)
    assert.ok(['on', 'off'].includes(row.default), row.surface)
    assert.match(row.tosRef, /^docs\/TOS\.md#/, row.surface)
    assert.match(row.doc, /^docs\//, row.surface)
    assert.ok(Array.isArray(row.actions) && row.actions.length > 0, row.surface)
  }
  const byName = new Map(matrix.rows.map((row) => [row.surface, row]))
  assert.equal(byName.get('mail.extract').default, 'off')
  assert.equal(byName.get('kb.ask').default, 'off')
  assert.equal(byName.get('mail.extract').gate, 'enforced-policy')
  assert.equal(byName.get('kb.ask').gate, 'enforced-policy')
  assert.equal(byName.get('chat').gate, 'legacy-gate')
  assert.equal(byName.get('export').gate, 'enforced-policy')
  // Deterministic: a second call is deep-equal (no timestamps in the matrix).
  assert.deepEqual(surfaceMatrix(), matrix)
})
