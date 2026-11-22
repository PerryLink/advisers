/**
 * 0.5.0 M1 read disclosure unit tests (lib/disclosure.js).
 *
 * Pins the closed view vocabulary, the metadata-only digest/callId contract
 * (no record values), and the additive audit reason. The MCP/DSH payload
 * wiring is covered by test/mcp-disclosure.test.js and the DSH adapter suite.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DISCLOSURE_SURFACES,
  READ_BASIS,
  READ_VIEWS,
  buildDisclosure,
  canonicalJson,
  disclosureAuditReason,
  disclosureDigest,
  fieldsOf,
  sha256Hex,
  verificationOf,
  viewCountsOf,
  viewOf,
  withAudited,
} from '../lib/disclosure.js'

test('closed vocabularies: views, basis and disclosure surfaces', () => {
  assert.deepEqual([...READ_VIEWS], ['verified', 'pending', 'historical', 'derived'])
  assert.deepEqual([...READ_BASIS], ['local-resolution', 'preview'])
  assert.deepEqual([...DISCLOSURE_SURFACES], ['mcp', 'dsh'])
})

test('viewOf: verified requires a resolved local evidence pointer, historical wins over it', () => {
  assert.equal(viewOf('commitment', { status: 'open' }, { resolved: 1 }), 'verified')
  assert.equal(viewOf('commitment', { status: 'open' }, { resolved: 0 }), 'pending')
  assert.equal(viewOf('commitment', { status: 'open' }, null), 'pending')
  assert.equal(viewOf('commitment', { status: 'done' }, { resolved: 1 }), 'historical')
  assert.equal(viewOf('commitment', { status: 'dropped' }, { resolved: 0 }), 'historical')
  assert.equal(viewOf('fact', { status: 'confirmed' }, { resolved: 2 }), 'verified')
  assert.equal(viewOf('fact', { status: 'candidate' }, { resolved: 2 }), 'pending')
  assert.equal(viewOf('fact', { status: 'superseded' }, { resolved: 1 }), 'historical')
  assert.equal(viewOf('fact', { status: 'confirmed', expiredAt: '2026-01-01T00:00:00.000Z' }, { resolved: 1 }), 'historical')
  assert.equal(viewOf('preference', { status: 'confirmed' }, { resolved: 1 }), 'verified')
  assert.equal(viewOf('preference', { status: 'deprecated' }, { resolved: 1 }), 'historical')
  assert.equal(viewOf('client', { id: 'cl_1' }, { resolved: 9 }), 'derived')
  assert.equal(viewOf('unknown-kind', { status: 'confirmed' }, { resolved: 1 }), 'pending')
})

test('verificationOf counts the four resolver buckets (with optional totals override)', () => {
  assert.deepEqual(verificationOf(undefined), { basis: 'local-resolution', resolved: 0, missing: 0, unverifiable: 0, notChecked: 0 })
  const resolved = verificationOf({ sources: [{}, {}], missing: [{}], unverifiable: [{}], notChecked: [{}, {}, {}] })
  assert.deepEqual(resolved, { basis: 'local-resolution', resolved: 2, missing: 1, unverifiable: 1, notChecked: 3 })
  const capped = verificationOf({ sources: [{}] }, { resolved: 20, missing: 3 })
  assert.equal(capped.resolved, 20)
  assert.equal(capped.missing, 3)
})

test('viewCountsOf and fieldsOf are deterministic metadata helpers', () => {
  assert.deepEqual(viewCountsOf(['verified', 'pending', 'verified', 'nope']), { verified: 2, pending: 1, historical: 0, derived: 0 })
  assert.deepEqual(viewCountsOf(undefined), { verified: 0, pending: 0, historical: 0, derived: 0 })
  assert.deepEqual(fieldsOf([{ b: 'x', a: 'y' }, null, 'raw', { a: 'z', view: 'pending' }]), ['a', 'b'])
  assert.deepEqual(fieldsOf(undefined), [])
})

test('buildDisclosure: stable shape, content-addressed callId/digest, same metadata = same ids', () => {
  const first = buildDisclosure({ tool: 'advisers_today', fields: ['id', 'action', 'id'], views: ['verified', 'pending'], clearance: 0, protectedExcluded: 1 })
  assert.deepEqual(Object.keys(first), ['surface', 'tool', 'basis', 'callId', 'fields', 'view', 'clearance', 'protectedExcluded', 'truncated', 'audited', 'digest'])
  assert.equal(first.surface, 'mcp')
  assert.equal(first.basis, 'local-resolution')
  assert.deepEqual(first.fields, ['action', 'id'], 'fields are de-duplicated and sorted')
  assert.deepEqual(first.view, { verified: 1, pending: 1, historical: 0, derived: 0 })
  assert.match(first.callId, /^dc_[0-9a-f]{16}$/)
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.callId, 'dc_' + first.digest.slice('sha256:'.length, 'sha256:'.length + 16))
  assert.equal(first.audited, false)
  assert.equal(first.truncated, false)
  const second = buildDisclosure({ tool: 'advisers_today', fields: ['action', 'id'], views: ['pending', 'verified'], clearance: 0, protectedExcluded: 1 })
  assert.equal(second.callId, first.callId, 'the same disclosure metadata is content-addressed to the same id')
  assert.equal(second.digest, first.digest)
  const otherTool = buildDisclosure({ tool: 'advisers_who', fields: ['action', 'id'], views: ['verified', 'pending'] })
  assert.notEqual(otherTool.callId, first.callId)
  const otherCounts = buildDisclosure({ tool: 'advisers_today', fields: ['action', 'id'], views: ['pending'] })
  assert.notEqual(otherCounts.callId, first.callId)
})

test('disclosure never embeds record values, quotes, ids or paths', () => {
  const rows = [
    { id: 'cm_secret_id', action: '把报价发给王工', creditor: '王工', quote: '周五前发报价单' },
    { id: 'cm_two', action: 'secret acquisition', creditor: 'ACME' },
  ]
  const disclosure = buildDisclosure({ tool: 'advisers_today', fields: fieldsOf(rows), views: ['verified', 'pending'], clearance: 0, protectedExcluded: 2 })
  const text = JSON.stringify(disclosure)
  for (const needle of ['cm_secret_id', '王工', '报价', '周五前', 'ACME', 'secret acquisition']) {
    assert.ok(!text.includes(needle), 'disclosure must not contain the value ' + needle)
  }
  assert.ok(disclosure.fields.includes('action'), 'field names are the disclosure payload')
})

test('withAudited only flips audited/warning; the digest does not depend on the audit outcome', () => {
  const disclosure = buildDisclosure({ tool: 'advisers_who', fields: ['id'], views: ['pending'], clearance: 1 })
  const digestBefore = disclosure.digest
  const callIdBefore = disclosure.callId
  withAudited(disclosure, false, 'audit chain unavailable: test')
  assert.equal(disclosure.audited, false)
  assert.equal(disclosure.warning, 'audit chain unavailable: test')
  assert.equal(disclosure.digest, digestBefore)
  assert.equal(disclosure.callId, callIdBefore)
  assert.equal(disclosureDigest(disclosure), disclosure.digest)
  withAudited(disclosure, true)
  assert.equal(disclosure.audited, true)
  assert.equal(Object.hasOwn(disclosure, 'warning'), false, 'a successful audit drops the warning')
})

test('disclosureAuditReason: label + callId/view/clearance/fields/digest, never values', () => {
  const disclosure = buildDisclosure({ tool: 'advisers_commit_ls', fields: ['action', 'id'], views: ['verified', 'pending'], clearance: 0 })
  const reason = disclosureAuditReason('advisers_commit_ls', disclosure)
  assert.ok(reason.startsWith('advisers_commit_ls callId=dc_'))
  assert.ok(reason.includes(' view=verified:1,pending:1,historical:0,derived:0'))
  assert.ok(reason.includes(' clearance=0 '))
  assert.ok(reason.includes(' fields=action,id '))
  assert.ok(reason.endsWith(' digest=' + disclosure.digest))
  assert.equal(disclosureAuditReason('advisers_who', null), 'advisers_who')
})

test('canonicalJson sorts recursively; sha256Hex is stable', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}')
  assert.equal(sha256Hex('advisers'), sha256Hex('advisers'))
  assert.match(sha256Hex('advisers'), /^[0-9a-f]{64}$/)
})
