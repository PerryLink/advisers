/**
 * Decision tokens (0.4 grant-lite): authorize() -> one-shot token bound to an
 * effectDigest, consumeDecision()/runWithDecision() verification + audit.
 *
 * The token is deliberately NOT a secret and NOT cross-process: it catches a
 * code path that forgot the gate or reuses an allow for a different effect.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECISION_TOKEN_TTL_MS,
  POLICY_CODES,
  authorize,
  clearDecisionTokens,
  consumeDecision,
  decisionTokenCount,
  decisionView,
  effectDigestOf,
  runWithDecision,
} from '../lib/policy/index.js'

const NOW = new Date('2026-11-21T03:00:00.000Z')

function writeFacts(overrides = {}) {
  return {
    surface: 'agent',
    action: 'write-fs',
    dataClass: 'tool',
    tos: { accepted: true },
    audit: { available: true },
    path: 'workspace',
    ...overrides,
  }
}

const WRITE_EFFECT = { surface: 'agent', action: 'write-fs', dataClass: 'tool', path: 'workspace', record: null }

function currentToken(facts = writeFacts()) {
  const result = authorize('write-fs', facts, { now: NOW, audit: () => {} })
  assert.equal(result.authorized, true, JSON.stringify(result))
  return result.token
}

test('authorize issues a one-shot token bound to the effect digest and writes an intent audit', () => {
  clearDecisionTokens()
  const events = []
  const result = authorize('write-fs', writeFacts(), { now: NOW, audit: (event) => events.push(event) })
  assert.equal(result.authorized, true)
  assert.equal(result.decision, 'allow')
  assert.equal(result.code, null)
  assert.ok(result.decisionId.startsWith('dec_'))
  assert.equal(result.token.decisionId, result.decisionId)
  assert.equal(result.token.effectDigest, effectDigestOf(WRITE_EFFECT))
  assert.equal(result.token.effectDigest, result.effectDigest)
  assert.equal(result.expiresAt, new Date(NOW.getTime() + DECISION_TOKEN_TTL_MS).toISOString())
  assert.equal(result.auditWritten, true)
  assert.equal(events.length, 1)
  assert.equal(events[0].phase, 'intent')
  assert.equal(events[0].decision, 'allow')
  assert.equal(events[0].effectDigest, result.effectDigest)
  assert.deepEqual(events[0].ruleIds, ['R-P04-10'])
  assert.equal(decisionTokenCount(), 1)
  const view = decisionView(result)
  assert.equal(view.decisionId, undefined, 'the generic decision view never carries the token in-process map id')
  assert.equal(view.effectDigest, result.effectDigest)
  assert.equal(JSON.stringify(result).includes('quoted user content'), false)
})

test('consumeDecision accepts the matching effect exactly once', () => {
  clearDecisionTokens()
  const token = currentToken()
  const consumed = consumeDecision(token, WRITE_EFFECT, { now: NOW })
  assert.equal(consumed.decisionId, token.decisionId)
  assert.equal(consumed.auditRequired, true)
  assert.throws(
    () => consumeDecision(token, WRITE_EFFECT, { now: NOW }),
    (error) => {
      assert.equal(error.code, POLICY_CODES.POLICY_TOKEN_REPLAY.code)
      return true
    },
  )
})

test('tampered or unknown tokens fail closed', () => {
  clearDecisionTokens()
  const digest = currentToken().effectDigest
  const token = currentToken()
  const cases = [
    [{ ...token, effectDigest: 'sha256:' + '0'.repeat(64) }, POLICY_CODES.POLICY_TOKEN_INVALID.code],
    [{ ...token, surface: 'chat' }, POLICY_CODES.POLICY_TOKEN_INVALID.code],
    [{ ...token, action: 'exec' }, POLICY_CODES.POLICY_TOKEN_INVALID.code],
    [{ ...token, decisionId: 'dec_forged' }, POLICY_CODES.POLICY_TOKEN_UNKNOWN.code],
    [null, POLICY_CODES.POLICY_TOKEN_INVALID.code],
    [{}, POLICY_CODES.POLICY_TOKEN_INVALID.code],
    [{ decisionId: token.decisionId, effectDigest: digest }, POLICY_CODES.POLICY_TOKEN_INVALID.code],
  ]
  for (const [candidate, code] of cases) {
    assert.throws(
      () => consumeDecision(candidate, WRITE_EFFECT, { now: NOW }),
      (error) => {
        assert.equal(error.code, code, JSON.stringify(candidate))
        return true
      },
    )
  }
})

test('a token issued for one effect cannot execute a different effect', () => {
  clearDecisionTokens()
  const token = currentToken()
  assert.throws(
    () => consumeDecision(token, { ...WRITE_EFFECT, path: 'outside' }, { now: NOW }),
    (error) => {
      assert.equal(error.code, POLICY_CODES.POLICY_TOKEN_EFFECT_MISMATCH.code)
      return true
    },
  )
})

test('expired tokens are refused', () => {
  clearDecisionTokens()
  const result = authorize('write-fs', writeFacts(), { now: NOW, ttlMs: 1000, audit: () => {} })
  assert.throws(
    () => consumeDecision(result.token, WRITE_EFFECT, { now: new Date(NOW.getTime() + 2000) }),
    (error) => {
      assert.equal(error.code, POLICY_CODES.POLICY_TOKEN_EXPIRED.code)
      return true
    },
  )
})

test('runWithDecision executes once, writes a result audit and rethrows effect errors', () => {
  clearDecisionTokens()
  const events = []
  const audit = (event) => events.push(event)
  const authorised = authorize('write-fs', writeFacts(), { now: NOW, audit })
  const value = runWithDecision(authorised.token, WRITE_EFFECT, () => 'written', { now: NOW, audit })
  assert.equal(value, 'written')
  assert.deepEqual(events.map((event) => event.phase), ['intent', 'result'])
  assert.equal(events[1].ok, true)
  assert.equal(events[1].decisionId, authorised.decisionId)
  // A second execution with the same token is refused (never double-executes).
  assert.throws(
    () => runWithDecision(authorised.token, WRITE_EFFECT, () => 'again', { now: NOW, audit }),
    (error) => error.code === POLICY_CODES.POLICY_TOKEN_REPLAY.code,
  )
  // Errors from the effect are audited as failed and rethrown unchanged.
  const failing = authorize('write-fs', writeFacts(), { now: NOW, audit })
  const boom = new Error('disk on fire')
  assert.throws(
    () => runWithDecision(failing.token, WRITE_EFFECT, () => { throw boom }, { now: NOW, audit }),
    (error) => error === boom,
  )
  assert.equal(events[events.length - 1].ok, false)
})

test('a missing or failing audit callback refuses the side effect (no token)', () => {
  clearDecisionTokens()
  const missing = authorize('write-fs', writeFacts(), { now: NOW })
  assert.equal(missing.authorized, false)
  assert.equal(missing.token, null)
  assert.equal(missing.code, POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code)
  assert.equal(missing.auditWritten, false)
  const throwing = authorize('write-fs', writeFacts(), { now: NOW, audit: () => { throw new Error('db locked') } })
  assert.equal(throwing.authorized, false)
  assert.equal(throwing.code, POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code)
  assert.equal(decisionTokenCount(), 0)
  const asyncAudit = authorize('write-fs', writeFacts(), { now: NOW, audit: async () => {} })
  assert.equal(asyncAudit.authorized, false)
  assert.equal(asyncAudit.code, POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code)
})

test('deny/confirm decisions never issue a token and are still audited', () => {
  clearDecisionTokens()
  const events = []
  const denied = authorize('write-fs', writeFacts({ tos: null }), { now: NOW, audit: (event) => events.push(event) })
  assert.equal(denied.authorized, false)
  assert.equal(denied.token, null)
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.code, POLICY_CODES.POLICY_TOS_REQUIRED.code)
  assert.equal(events.length, 1)
  assert.equal(events[0].phase, 'decision')
  assert.equal(events[0].decision, 'deny')
  assert.equal(decisionTokenCount(), 0)

  const confirmed = authorize(
    'write-fs',
    writeFacts({ trust: { tainted: true }, interactive: true, confirmed: false }),
    { now: NOW, audit: (event) => events.push(event) },
  )
  assert.equal(confirmed.authorized, false)
  assert.equal(confirmed.decision, 'confirm')
  assert.equal(confirmed.token, null)
})

test('read-only actions authorize without an audit callback', () => {
  clearDecisionTokens()
  const facts = { surface: 'mcp', action: 'read', tos: { accepted: true } }
  const result = authorize('read', facts, { now: NOW })
  assert.equal(result.authorized, true)
  assert.equal(result.auditWritten, false)
  const effect = { surface: 'mcp', action: 'read', dataClass: 'ledger', record: null }
  const consumed = consumeDecision(result.token, effect, { now: NOW })
  assert.equal(consumed.auditRequired, false)
})

test('a result-audit failure after the effect is reported explicitly', () => {
  clearDecisionTokens()
  let calls = 0
  let effectRan = false
  const audit = () => {
    calls += 1
    if (calls > 1) throw new Error('audit chain broken')
  }
  const authorised = authorize('write-fs', writeFacts(), { now: NOW, audit })
  assert.throws(
    () => runWithDecision(authorised.token, WRITE_EFFECT, () => { effectRan = true }, { now: NOW, audit }),
    (error) => {
      assert.equal(error.code, POLICY_CODES.POLICY_AUDIT_UNAVAILABLE.code)
      assert.equal(error.details.effectCompleted, true)
      return true
    },
  )
  assert.equal(effectRan, true)
})

test('clearDecisionTokens drops every outstanding token', () => {
  clearDecisionTokens()
  const token = currentToken()
  clearDecisionTokens()
  assert.equal(decisionTokenCount(), 0)
  assert.throws(
    () => consumeDecision(token, WRITE_EFFECT, { now: NOW }),
    (error) => error.code === POLICY_CODES.POLICY_TOKEN_UNKNOWN.code,
  )
})
