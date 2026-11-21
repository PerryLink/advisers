/**
 * Egress registry + checkEgress(kind, meta): every model/net/fs/send/spawn path
 * registered once, unknown paths fail closed, runtime facts delegate to
 * evaluate(). Also pins the legacy lib/egress.js export surface (the 0.4
 * registry is additive and must not change that module's semantics).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as legacyEgress from '../lib/egress.js'
import {
  EGRESS_REGISTRY,
  EGRESS_SINKS,
  POLICY_CODES,
  SURFACE_REGISTRY,
  checkEgress,
  findEgressEntry,
  getEgressEntry,
  getSurface,
  listEgress,
  normalizeEgressKind,
} from '../lib/policy/index.js'

function facts(overrides = {}) {
  return {
    tos: { accepted: true },
    audit: { available: true },
    safety: { action: 'allow' },
    consent: null,
    ...overrides,
  }
}

test('the egress registry is coherent with the surface registry', () => {
  const ids = new Set()
  const surfaces = new Map(SURFACE_REGISTRY.map((row) => [row.surface, row]))
  for (const entry of EGRESS_REGISTRY) {
    assert.equal(ids.has(entry.id), false, 'duplicate egress id ' + entry.id)
    ids.add(entry.id)
    assert.ok(EGRESS_SINKS.includes(entry.sink), entry.id + ' sink ' + entry.sink)
    const surface = surfaces.get(entry.surface)
    assert.ok(surface, entry.id + ' references an unknown surface ' + entry.surface)
    assert.equal(entry.gate, surface.gate, entry.id + ' gate must match the surface registry')
    assert.ok(surface.actions.includes(entry.action), entry.id + ' action not declared by the surface')
    assert.match(entry.entry, /\S/, entry.id + ' needs an entry point')
    assert.match(entry.tosRef, /^docs\/TOS\.md#/, entry.id)
    assert.ok(['on', 'off'].includes(entry.default), entry.id)
  }
  assert.ok(EGRESS_REGISTRY.length >= 12)
  assert.ok(getEgressEntry('chat.model'))
  assert.equal(getEgressEntry('nope'), null)
  // Every surface row with a non-'none' sink has at least one registered path.
  for (const row of SURFACE_REGISTRY) {
    if (row.sink === 'none') continue
    const covered = EGRESS_REGISTRY.some((entry) => entry.surface === row.surface)
    assert.equal(covered, true, 'surface ' + row.surface + ' has sink ' + row.sink + ' but no egress row')
  }
})

test('listEgress is a deterministic JSON-ready copy', () => {
  const first = listEgress()
  assert.deepEqual(listEgress(), first)
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(first))), JSON.stringify(first))
  assert.equal(first.length, EGRESS_REGISTRY.length)
  for (const row of first) assert.deepEqual(Object.keys(row), ['id', 'surface', 'action', 'dataClass', 'sink', 'entry', 'default', 'gate', 'tosRef'])
})

test('normalizeEgressKind maps sink aliases and rejects unknown kinds', () => {
  assert.equal(normalizeEgressKind('model'), 'model')
  assert.equal(normalizeEgressKind('model-egress'), 'model')
  assert.equal(normalizeEgressKind(' MODEL '), 'model')
  assert.equal(normalizeEgressKind('net-egress'), 'net')
  assert.equal(normalizeEgressKind('exec'), 'spawn')
  assert.equal(normalizeEgressKind('telnet'), null)
  assert.equal(normalizeEgressKind(null), null)
})

test('findEgressEntry resolves by id or selector and never guesses on ambiguity', () => {
  assert.equal(findEgressEntry('model', { id: 'chat.model' }).id, 'chat.model')
  assert.equal(findEgressEntry('model', { surface: 'mail.extract' }).id, 'mail.extract.model')
  assert.equal(findEgressEntry('model', { surface: 'chat', action: 'model-egress' }).id, 'chat.model')
  assert.equal(findEgressEntry('model', { surface: 'nope' }), null)
  assert.equal(findEgressEntry('fs', { surface: 'export' }), null, 'two export rows must not be guessed')
  assert.equal(findEgressEntry('telnet', {}), null)
})

test('checkEgress without runtime facts is an honest registry-only probe', () => {
  const result = checkEgress('model', { surface: 'chat' })
  assert.equal(result.registered, true)
  assert.equal(result.checked, false)
  assert.equal(result.decision, 'not_checked')
  assert.equal(result.code, null)
  assert.equal(result.id, 'chat.model')
  assert.equal(result.entry.entry, 'lib/model.js#chatCompletion')
  assert.equal(result.gate, getSurface('chat').gate)
})

test('checkEgress delegates to evaluate() when runtime facts are supplied', () => {
  const allowed = checkEgress('model', { id: 'chat.model', facts: facts() })
  assert.equal(allowed.registered, true)
  assert.equal(allowed.checked, true)
  assert.equal(allowed.decision, 'allow')
  assert.equal(allowed.id, 'chat.model')
  assert.ok(allowed.effectDigest.startsWith('sha256:'))

  const denied = checkEgress('model', { id: 'chat.model', facts: facts({ tos: null }) })
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.code, POLICY_CODES.POLICY_TOS_REQUIRED.code)

  const noConsent = checkEgress('model', { id: 'mail.extract.model', facts: facts() })
  assert.equal(noConsent.decision, 'deny')
  assert.equal(noConsent.code, POLICY_CODES.POLICY_CONSENT_REQUIRED.code)

  const consent = { dataClass: 'mail', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', granted: true, surface: 'mail.extract' }
  const withConsent = checkEgress('model', { id: 'mail.extract.model', facts: facts({ consent }) })
  assert.equal(withConsent.decision, 'allow')
  assert.deepEqual(withConsent.obligations, ['audit.intent', 'audit.result', 'consent.record'])
})

test('unregistered or ambiguous egress paths fail closed', () => {
  const unregistered = checkEgress('model', { surface: 'kb.search' })
  assert.equal(unregistered.registered, false)
  assert.equal(unregistered.decision, 'deny')
  assert.equal(unregistered.code, POLICY_CODES.POLICY_EGRESS_UNREGISTERED.code)

  const unknownSink = checkEgress('telnet', { surface: 'chat' })
  assert.equal(unknownSink.registered, false)
  assert.equal(unknownSink.kind, null)
  assert.equal(unknownSink.code, POLICY_CODES.POLICY_EGRESS_UNREGISTERED.code)

  const ambiguous = checkEgress('fs', { surface: 'export' })
  assert.equal(ambiguous.registered, false)
  assert.equal(ambiguous.decision, 'deny')
  assert.deepEqual(ambiguous.candidates, ['export.evidence-pack', 'export.receipt-pack'])
})

test('the registry covers the 0.4 data surfaces (mail.extract/kb.ask default off)', () => {
  const rows = new Map(listEgress().map((row) => [row.id, row]))
  assert.equal(rows.get('mail.extract.model').default, 'off')
  assert.equal(rows.get('mail.extract.model').gate, 'enforced-policy')
  assert.equal(rows.get('kb.ask.model').default, 'off')
  assert.equal(rows.get('kb.ask.model').gate, 'enforced-policy')
  assert.ok(rows.has('mail.sync'))
  assert.ok(rows.has('notify.webhook'))
  assert.ok(rows.has('export.evidence-pack'))
  assert.ok(rows.has('export.receipt-pack'))
  assert.ok(rows.has('agent.exec'))
})

test('legacy lib/egress.js exports and semantics are untouched', () => {
  assert.deepEqual(Object.keys(legacyEgress).sort(), ['egressDeniedReason', 'secrecyLevel'])
  assert.equal(legacyEgress.secrecyLevel({ secrecy: 3 }), 3)
  assert.equal(legacyEgress.secrecyLevel(undefined), 0)
  assert.equal(legacyEgress.secrecyLevel({ secrecy: 'x' }), Number.POSITIVE_INFINITY)
  assert.match(legacyEgress.egressDeniedReason({ secrecy: 1 }), /disabled for protected matters/)
  assert.match(legacyEgress.egressDeniedReason(null), /active matter not found/)
  assert.equal(legacyEgress.egressDeniedReason({ secrecy: 0 }), null)
})
