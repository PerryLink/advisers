/**
 * Contract gate tests (Advisers 0.3.0).
 *
 * These tests protect the interface constitution under contracts/ and the
 * single-source error-code registry, and run the real gate once against the
 * real CLI/MCP binary. They are deliberately dependency-free and offline: the
 * gate itself creates a temporary ADVISERS_HOME and never needs a key/model.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  DSH_ERROR_CODES,
  ERROR_CATEGORIES,
  ERROR_CODE_LIST,
  ERROR_CODE_VERSION,
  ERROR_CODES,
  ERROR_CODES_ADDITIVE_RELEASES,
  ERROR_CODES_BASELINE_COUNT,
  ERROR_CODES_FROZEN_AT,
  ERROR_CODES_RELEASE,
  ERROR_SURFACES,
  errorEnvelope,
  exitCodeFor,
  isKnownErrorCode,
} from '../lib/error-codes.js'
import {
  auditSchemaKeywords,
  buildRegistryJson,
  renderErrorCodesDoc,
  resolvePointer,
  scanErrorCodeLiterals,
  topLevelDefs,
  validateInstance,
  validateTarget,
} from '../../../scripts/check-contracts.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const contractsDir = join(root, 'contracts')
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))
const readText = (rel) => readFileSync(join(root, rel), 'utf8')

test('contracts: the error registry is structurally valid', () => {
  assert.equal(ERROR_CODE_VERSION, 1)
  assert.equal(ERROR_CODES_RELEASE, '0.4.0')
  assert.equal(ERROR_CODES_BASELINE_COUNT, 50, 'the 0.2.4 committed baseline count is frozen')
  assert.match(ERROR_CODES_FROZEN_AT, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual([...ERROR_CODES_ADDITIVE_RELEASES], ['0.3.0', '0.4.0', '0.4.3', '0.5.0', '0.5.1'])
  const baseline = ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].since === '0.2.x')
  const additive = ERROR_CODE_LIST.filter((code) => ERROR_CODES_ADDITIVE_RELEASES.includes(ERROR_CODES[code].since))
  const sinceCount = (release) => ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].since === release).length
  assert.equal(baseline.length, ERROR_CODES_BASELINE_COUNT, 'since: 0.2.x entries must equal the baseline count')
  assert.ok(sinceCount('0.3.0') >= 50, '0.3.0 additive codes are registered ahead of their module commit')
  assert.ok(sinceCount('0.4.0') >= 40, '0.4.0 additive codes (KB/mail/policy/receivables) are registered ahead of their module commit')
  assert.ok(sinceCount('0.4.3') >= 3, '0.4.3 additive codes (due/capture/inbox) are registered ahead of their module commit')
  assert.ok(sinceCount('0.5.0') >= 15, '0.5.0 additive codes (bundle/context-pack/sync/demo) are registered ahead of their module commit')
  assert.ok(sinceCount('0.5.1') >= 3, '0.5.1 additive codes (mail followup) are registered ahead of their module commit')
  assert.equal(additive.length, ERROR_CODE_LIST.length - baseline.length, 'every non-baseline code declares a known additive layer')
  assert.deepEqual(ERROR_CODE_LIST, [...ERROR_CODE_LIST].sort(), 'ERROR_CODE_LIST must be sorted')
  assert.equal(ERROR_CODE_LIST.length, Object.keys(ERROR_CODES).length, 'the code list and object must agree')

  for (const code of ERROR_CODE_LIST) {
    const entry = ERROR_CODES[code]
    assert.match(code, /^E_[A-Z][A-Z0-9_]*$/, 'CLI codes use the E_UPPER_SNAKE shape: ' + code)
    assert.equal(entry.code, code)
    assert.ok(ERROR_CATEGORIES.includes(entry.category), code + ' has an unknown category')
    assert.ok(Number.isInteger(entry.exit) && entry.exit >= 0, code + ' has a non-integer exit')
    assert.ok(Array.isArray(entry.surfaces) && entry.surfaces.length > 0, code + ' has no surfaces')
    for (const surface of entry.surfaces) assert.ok(ERROR_SURFACES.includes(surface), code + ' has an unknown surface')
    assert.equal(typeof entry.remedy, 'string')
    assert.ok(entry.remedy.length >= 10, code + ' needs an actionable remedy')
    assert.equal(typeof entry.stable, 'boolean')
    assert.ok(entry.since === '0.2.x' || ERROR_CODES_ADDITIVE_RELEASES.includes(entry.since), code + ' has an unknown since layer')
    if (entry.doc) {
      assert.ok(existsSync(join(root, entry.doc)), code + ' doc is missing: ' + entry.doc)
      assert.ok(readText(entry.doc).includes(code), code + ' doc does not mention the code: ' + entry.doc)
    }
  }
  assert.equal(ERROR_CODES.E_TOS_REQUIRED.exit, 3, 'TOS consent is the only exit-3 code')
  for (const code of ERROR_CODE_LIST) {
    if (code !== 'E_TOS_REQUIRED') assert.equal(ERROR_CODES[code].exit, 1, code + ' must map to exit 1')
  }
  const dshCodes = Object.keys(DSH_ERROR_CODES)
  assert.ok(dshCodes.length >= 5, 'DSH external vocabulary must be preserved')
  for (const code of dshCodes) {
    assert.ok(!code.startsWith('E_'), 'DSH external codes are not E_* codes: ' + code)
    assert.ok(!Object.hasOwn(ERROR_CODES, code), 'DSH external codes must not collide with CLI codes')
    assert.equal(DSH_ERROR_CODES[code].surfaces[0], 'dsh')
  }
})

test('contracts: exit mapping and error-envelope helpers behave', () => {
  assert.equal(exitCodeFor('E_TOS_REQUIRED'), 3)
  assert.equal(exitCodeFor('E_USAGE'), 1)
  assert.equal(exitCodeFor('E_NOT_REGISTERED_ANYWHERE'), 1, 'unknown codes fall back to the generic error exit')
  assert.equal(isKnownErrorCode('E_USAGE'), true)
  assert.equal(isKnownErrorCode('INVALID_ARGUMENT'), true)
  assert.equal(isKnownErrorCode('E_NOPE'), false)
  const envelope = errorEnvelope('E_USAGE', 'bad args', { hint: 'advisers --help', details: { path: '--days' }, ignored: 1 })
  assert.deepEqual(envelope, { error: { code: 'E_USAGE', message: 'bad args', hint: 'advisers --help', details: { path: '--days' } } })
  const schema = readJson('contracts/cli/errors-v1.schema.json')
  assert.deepEqual(validateTarget(envelope, schema, '#'), [])
})

test('contracts: the strict validator rejects bad payloads (negative controls)', () => {
  const schema = {
    $defs: {
      Sample: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'name'],
        properties: {
          count: { type: 'integer', minimum: 0, maximum: 10 },
          name: { type: 'string', minLength: 2, pattern: '^ok' },
          mode: { type: 'string', enum: ['a', 'b'] },
          version: { type: 'integer', const: 1 },
          nested: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
        },
      },
      Maybe: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      BrokenRef: { $ref: '#/$defs/Missing' },
    },
  }
  const valid = { count: 1, name: 'ok-name', mode: 'a', version: 1, nested: { id: 'x' } }
  assert.deepEqual(validateTarget(valid, schema, '#/$defs/Sample'), [])
  const rejects = [
    ['missing required property', { count: 1 }],
    ['wrong type', { count: '1', name: 'ok-name' }],
    ['minimum', { count: -1, name: 'ok-name' }],
    ['maximum', { count: 11, name: 'ok-name' }],
    ['minLength', { count: 1, name: 'o' }],
    ['pattern', { count: 1, name: 'nope' }],
    ['enum', { count: 1, name: 'ok-name', mode: 'c' }],
    ['const', { count: 1, name: 'ok-name', version: 2 }],
    ['additionalProperties', { count: 1, name: 'ok-name', extra: true }],
    ['nested additionalProperties', { count: 1, name: 'ok-name', nested: { id: 'x', extra: 1 } }],
  ]
  for (const [label, value] of rejects) {
    const errors = validateTarget(value, schema, '#/$defs/Sample')
    assert.ok(errors.length > 0, 'validator accepted an invalid payload (' + label + ')')
  }
  assert.deepEqual(validateTarget(1, schema, '#/$defs/Maybe'), [])
  assert.ok(validateTarget(true, schema, '#/$defs/Maybe').length > 0, 'oneOf must reject non-matching branches')
  assert.ok(validateTarget(1, schema, '#/$defs/BrokenRef')[0].includes('unresolvable'), 'unresolved $ref must fail, not pass')
  assert.ok(validateTarget(1, { $defs: { X: { $ref: 'other.json#/x' } } }, '#/$defs/X')[0].includes('local'), 'external $ref must fail closed')
  const pointer = resolvePointer(schema, '#/$defs/Sample/properties/count')
  assert.equal(pointer.node.maximum, 10)
  assert.ok(resolvePointer(schema, '#/$defs/Nope').error)
})

test('contracts: schema keyword audit fails closed', () => {
  const errors = []
  auditSchemaKeywords({ type: 'object', unevaluatedProperties: false }, 'root', errors)
  assert.ok(errors.some((error) => error.includes('unsupported keyword')), 'unknown JSON-Schema keywords must fail the gate')
  const badAdditional = []
  auditSchemaKeywords({ type: 'object', additionalProperties: { type: 'string' } }, 'root', badAdditional)
  assert.ok(badAdditional.some((error) => error.includes('additionalProperties')), 'schema-valued additionalProperties is out of the supported subset')
  const good = []
  auditSchemaKeywords({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, 'root', good)
  assert.deepEqual(good, [])
})

test('contracts: generated registry/docs are in sync with the single source', () => {
  const registry = buildRegistryJson()
  assert.equal(registry.release, '0.4.0')
  assert.deepEqual(registry.baseline, { commit: '35a51c3', codeCount: ERROR_CODES_BASELINE_COUNT })
  assert.deepEqual(registry, readJson('contracts/errors/codes.v1.json'), 'contracts/errors/codes.v1.json is stale; run node scripts/check-contracts.mjs --update')
  assert.equal(renderErrorCodesDoc(), readText('docs/ERROR-CODES.md'), 'docs/ERROR-CODES.md is stale; run node scripts/check-contracts.mjs --update')
  assert.equal(registry.codes.length, ERROR_CODE_LIST.length)
  assert.equal(registry.external.length, Object.keys(DSH_ERROR_CODES).length)
  assert.deepEqual(registry.exitCodes, { default: 1, E_TOS_REQUIRED: 3 })
})

test('contracts: vector files cover every top-level $def', () => {
  const pairs = [
    ['contracts/cli/read-models-v1.schema.json', 'contracts/vectors/cli/read-models.vectors.json'],
    ['contracts/mcp/responses-v1.schema.json', 'contracts/vectors/mcp/responses.vectors.json'],
  ]
  for (const [schemaRel, vectorRel] of pairs) {
    const schema = readJson(schemaRel)
    const vectors = readJson(vectorRel)
    const expected = topLevelDefs(schema).map((name) => '#/$defs/' + name).sort()
    assert.deepEqual([...vectors.covers].sort(), expected, vectorRel + ' covers must equal the top-level $defs')
    assert.ok(vectors.cases.length >= 3)
    for (const testCase of vectors.cases) {
      assert.ok(testCase.id && testCase.target && (testCase.expect === 'accept' || testCase.expect === 'reject'))
    }
  }
  const envelopeVectors = readJson('contracts/vectors/cli/errors.vectors.json')
  assert.deepEqual(envelopeVectors.covers, ['#'])
})

test('contracts: the source scanner finds code literals', () => {
  const scanned = scanErrorCodeLiterals(['packages/advisers/lib/error-codes.js'])
  assert.ok(scanned.size >= 40, 'the scanner should find the frozen literal set in the registry module')
  assert.ok(scanned.has('E_TOS_REQUIRED'))
})

test('contracts: the full contract gate passes against the real CLI/MCP binary', { timeout: 240000 }, () => {
  const script = join(root, 'scripts/check-contracts.mjs')
  assert.ok(existsSync(script), 'scripts/check-contracts.mjs must exist')
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 240000 })
  assert.equal(result.status, 0, 'check-contracts must pass\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr)
  assert.match(result.stdout, /check-contracts: PASS/)
  for (const check of [
    'schema.artifacts', 'vectors.artifacts', 'cli.commands', 'status.schema',
    'exit.probes', 'mcp.surface', 'errors.registry-file', 'docs.consistency',
  ]) {
    assert.ok(result.stdout.includes('PASS ' + check), 'missing PASS for ' + check)
  }
})
