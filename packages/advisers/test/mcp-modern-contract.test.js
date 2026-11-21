import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import {
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  MODERN_CACHE_HINTS,
  MODERN_METHODS,
  MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RESOURCE_URIS,
  SUPPORTED_MODERN_PROTOCOL_VERSIONS,
  TOOL_NAMES,
  createMcpServer,
} from '../lib/mcp-server.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  CONTRACT_LICENSE,
  REQUIRED_SCHEMA_METADATA,
  auditSchemaKeywords,
  deepEqual,
  topLevelDefs,
  validateTarget,
} from '../../../scripts/check-contracts.mjs'

/**
 * 0.4.0 MCP modern contract artifacts (additive v2) and their agreement with
 * the implementation.
 *
 * The contract checker (scripts/check-contracts.mjs) already validates
 * contracts/mcp/responses-v2.schema.json via --schema and
 * contracts/vectors/mcp/modern.vectors.json via --vectors; this suite reuses
 * the checker's own validator exports to (a) pin the artifacts and (b) prove
 * that a real modern session matches the v2 envelope AND the frozen v1 payload
 * definitions (payload reuse, not duplication). The legacy deterministic eval
 * contract (initialize echo, required tools/resources) stays frozen.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const contractsDir = join(repoRoot, 'contracts')
const readContract = (rel) => JSON.parse(readFileSync(join(contractsDir, rel), 'utf8'))
const v1 = readContract('mcp/responses-v1.schema.json')
const v2 = readContract('mcp/responses-v2.schema.json')
const versionsV1 = readContract('mcp/versions-v1.json')
const versionsV2 = readContract('mcp/versions-v2.json')
const toolsCatalog = readContract('mcp/tools-v1.json')
const resourcesCatalog = readContract('mcp/resources-v1.json')
const vectorsPath = join(contractsDir, 'vectors/mcp/modern.vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'))
const MODERN_META = Object.freeze({
  [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
  [META_CLIENT_CAPABILITIES]: {},
})
const ENVELOPE_KEYS = ['resultType', 'ttlMs', 'cacheScope', '_meta']
const pointerOf = (schemaRef) => '#' + schemaRef.split('#')[1]

function stripEnvelope(response) {
  const result = {}
  for (const [key, value] of Object.entries(response.result)) {
    if (!ENVELOPE_KEYS.includes(key)) result[key] = value
  }
  return { jsonrpc: response.jsonrpc, id: response.id, result }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-modern-contract-'))
  const store = new SqliteStore(join(root, 'state.db'))
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A 报价', secrecy: 0 })
  const turn = store.addTurn({ conversationId: 'conv-1', role: 'user', content: '周五前把报价发给王工' })
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '发报价',
    dueAt: '2026-12-01T10:00:00+08:00',
    evidence: [{ sessionId: 'conv-1', turnId: turn.id, quote: '周五前把报价发给王工' }],
  })
  const packDir = join(root, 'pack')
  mkdirSync(packDir)
  const server = createMcpServer({
    store,
    ledger,
    version: '0.4.0-test',
    audit: () => {},
    now: () => new Date('2026-11-17T03:00:00.000Z'),
  })
  const call = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  const modernCall = (method, params, id = 1) => call(method, { ...(params ?? {}), _meta: MODERN_META }, id)
  const cleanup = () => {
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
  return { root, store, ledger, commitment, packDir, server, call, modernCall, cleanup }
}

test('responses-v2.schema.json is a valid member of the frozen contract set', () => {
  for (const key of REQUIRED_SCHEMA_METADATA) assert.ok(Object.hasOwn(v2, key), 'missing metadata ' + key)
  assert.equal(v2.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(v2.$id, 'https://github.com/PerryLink/advisers/contracts/mcp/responses-v2.schema.json')
  assert.equal(v2.version, 2)
  assert.equal(v2['x-license'], CONTRACT_LICENSE)
  assert.equal(v2['x-contract-status'], 'frozen')
  assert.match(v2['x-frozen-at'], /^\d{4}-\d{2}-\d{2}$/)
  assert.match(v2['x-source-commit'], /^[0-9a-f]{7,40}$/)
  assert.equal(v2['x-compat'], 'additive')
  const problems = []
  auditSchemaKeywords(v2, 'responses-v2', problems)
  assert.deepEqual(problems, [])
  assert.ok(Object.keys(v2.$defs).length >= 6)
})

test('modern.vectors.json covers every top-level v2 def with accept/reject cases', () => {
  assert.equal(vectors.version, 1)
  assert.equal(typeof vectors.description, 'string')
  const schemaPath = join(dirname(vectorsPath), vectors.schema)
  assert.equal(schemaPath, join(contractsDir, 'mcp/responses-v2.schema.json'))
  const expectedCovers = topLevelDefs(v2).map((name) => '#/$defs/' + name).sort()
  assert.deepEqual([...vectors.covers].sort(), expectedCovers)
  assert.ok(vectors.cases.length >= 18, 'expected a meaningful conformance matrix')
  let accepted = 0
  let rejected = 0
  for (const testCase of vectors.cases) {
    assert.equal(typeof testCase.id, 'string')
    assert.equal(typeof testCase.target, 'string')
    assert.ok(testCase.target.startsWith('#/$defs/'), testCase.id + ' target must be a local def')
    assert.ok(testCase.expect === 'accept' || testCase.expect === 'reject', testCase.id)
    const errors = validateTarget(testCase.value, v2, testCase.target)
    if (testCase.expect === 'accept') {
      accepted += 1
      assert.deepEqual(errors, [], testCase.id + ': ' + errors.join('; '))
    } else {
      rejected += 1
      assert.ok(errors.length > 0, testCase.id + ' was accepted but must be rejected')
    }
  }
  assert.ok(accepted >= 6)
  assert.ok(rejected >= 12)
})

test('versions-v2.json agrees with the implemented dual-era contract', () => {
  assert.equal(versionsV2.version, 2)
  assert.equal(versionsV2.status, 'frozen')
  assert.equal(versionsV2.compat, 'additive')
  assert.deepEqual(versionsV2.legacy.supportedProtocolVersions, versionsV1.supportedProtocolVersions)
  assert.equal(versionsV2.legacy.defaultProtocolVersion, versionsV1.defaultProtocolVersion)
  assert.equal(versionsV2.legacy.negotiation, versionsV1.negotiation)
  assert.equal(versionsV2.modern.protocolVersion, MODERN_PROTOCOL_VERSION)
  assert.deepEqual(versionsV2.modern.supportedVersions, [...SUPPORTED_MODERN_PROTOCOL_VERSIONS])
  assert.deepEqual(versionsV2.modern.methods, [...MODERN_METHODS])
  const requiredMeta = versionsV2.modern.requiredRequestMeta
  assert.equal(requiredMeta[META_PROTOCOL_VERSION].required, true)
  assert.equal(requiredMeta[META_CLIENT_CAPABILITIES].required, true)
  assert.equal(requiredMeta['io.modelcontextprotocol/clientInfo'].required, false)
  const cacheKeyByHint = {
    discover: 'server/discover',
    toolsList: 'tools/list',
    resourcesList: 'resources/list',
    resourcesRead: 'resources/read',
  }
  for (const [hint, method] of Object.entries(cacheKeyByHint)) {
    assert.deepEqual(versionsV2.modern.caching[method], {
      ttlMs: MODERN_CACHE_HINTS[hint].ttlMs,
      cacheScope: MODERN_CACHE_HINTS[hint].cacheScope,
    }, method)
  }
  assert.equal(versionsV2.modern.errorMapping.malformedMeta.code, -32602)
  assert.equal(versionsV2.modern.errorMapping.unsupportedProtocolVersion.code, -32022)
  assert.equal(versionsV2.modern.errorMapping.unknownMethod.code, -32601)
  assert.equal(versionsV2.modern.errorMapping.unknownResource.code, -32602)
  assert.equal(versionsV2.modern.errorMapping.unknownResource.legacyCodeForSameRequest, -32002)
  assert.equal(versionsV2.modern.errorMapping.toolExecutionFailure.isError, true)
  assert.equal(versionsV2.modern.pagination.supported, false)
  assert.equal(versionsV2.modern.pagination.invalidCursorError, -32602)
  assert.equal(versionsV2.modern.disableSwitch.env, 'ADVISERS_MCP_MODERN')
  assert.ok(versionsV2.modern.disableSwitch.offValues.includes('off'))
  assert.equal(join(contractsDir, versionsV2.conformance.schema).length > 0, true)
  assert.equal(join(contractsDir, versionsV2.conformance.vectors).length > 0, true)
  for (const rel of [versionsV2.conformance.schema, versionsV2.conformance.vectors]) {
    assert.doesNotThrow(() => readContract(rel), rel)
  }
})

test('a real modern session validates against the v2 envelope and the frozen v1 payloads', async () => {
  const f = createFixture()
  try {
    const discover = await f.modernCall('server/discover')
    assert.deepEqual(validateTarget(discover, v2, '#/$defs/DiscoverResult'), [])

    const toolsList = await f.modernCall('tools/list', undefined, 2)
    assert.deepEqual(validateTarget(toolsList, v2, '#/$defs/ToolsListResult'), [])
    assert.deepEqual(validateTarget(stripEnvelope(toolsList), v1, '#/$defs/ToolsListResult'), [])

    const resourcesList = await f.modernCall('resources/list', undefined, 3)
    assert.deepEqual(validateTarget(resourcesList, v2, '#/$defs/ResourcesListResult'), [])
    assert.deepEqual(validateTarget(stripEnvelope(resourcesList), v1, '#/$defs/ResourcesListResult'), [])

    // pack_verify embeds a verifiedAt timestamp, so payload bytes are not
    // comparable across two calls; it is validated against the schema only.
    const toolCalls = [
      ['advisers_today', {}, true],
      ['advisers_commit_ls', { all: true }, true],
      ['advisers_who', {}, true],
      ['advisers_evidence', { id: f.commitment.id }, true],
      ['advisers_remind', {}, true],
      ['advisers_clients', { action: 'list' }, true],
      ['advisers_pack_verify', { dir: f.packDir }, false],
    ]
    let id = 10
    for (const [name, args, deterministic] of toolCalls) {
      id += 1
      const modernResponse = await f.modernCall('tools/call', { name, arguments: args }, id)
      assert.deepEqual(validateTarget(modernResponse, v2, '#/$defs/ToolCallResult'), [], name + ' v2 envelope')
      assert.deepEqual(validateTarget(stripEnvelope(modernResponse), v1, '#/$defs/ToolCallResult'), [], name + ' v1 envelope')
      const legacyResponse = await f.call('tools/call', { name, arguments: args }, id + 100)
      if (deterministic) assert.equal(modernResponse.result.content[0].text, legacyResponse.result.content[0].text, name + ' payload bytes')
      assert.equal(modernResponse.result.isError, legacyResponse.result.isError, name + ' isError')
      if (modernResponse.result.isError === false) {
        const ref = toolsCatalog.tools.find((tool) => tool.name === name).responseSchemaRef
        assert.deepEqual(validateTarget(JSON.parse(modernResponse.result.content[0].text), v1, pointerOf(ref)), [], name + ' payload schema')
      }
    }

    for (const resource of resourcesCatalog.resources) {
      id += 1
      const modernResponse = await f.modernCall('resources/read', { uri: resource.uri }, id)
      assert.deepEqual(validateTarget(modernResponse, v2, '#/$defs/ResourceReadResult'), [], resource.uri + ' v2 envelope')
      assert.deepEqual(validateTarget(stripEnvelope(modernResponse), v1, '#/$defs/ResourceReadResult'), [], resource.uri + ' v1 envelope')
      const legacyResponse = await f.call('resources/read', { uri: resource.uri }, id + 100)
      assert.equal(modernResponse.result.contents[0].text, legacyResponse.result.contents[0].text, resource.uri + ' payload bytes')
      assert.deepEqual(validateTarget(JSON.parse(modernResponse.result.contents[0].text), v1, pointerOf(resource.schemaRef)), [], resource.uri + ' payload schema')
    }

    const unsupported = await f.call('tools/list', {
      _meta: { [META_PROTOCOL_VERSION]: '2025-11-25', [META_CLIENT_CAPABILITIES]: {} },
    }, 90)
    assert.deepEqual(validateTarget(unsupported, v2, '#/$defs/UnsupportedProtocolVersionError'), [])
    const missingCapabilities = await f.call('tools/list', {
      _meta: { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION },
    }, 91)
    assert.deepEqual(validateTarget(missingCapabilities, v1, '#/$defs/JsonRpcErrorResponse'), [])
    const unknownResource = await f.modernCall('resources/read', { uri: 'advisers://does-not-exist' }, 92)
    assert.equal(unknownResource.error.code, -32602)
    assert.deepEqual(validateTarget(unknownResource, v1, '#/$defs/JsonRpcErrorResponse'), [])
  } finally {
    f.cleanup()
  }
})

test('deterministic eval contract for the legacy MCP surface is unchanged', () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, 'eval/det/baseline.json'), 'utf8'))
  assert.equal(baseline.schemaVersion, 1)
  const mcpContract = baseline.contract.mcp
  assert.deepEqual(mcpContract.initializeEchoVersions, [PROTOCOL_VERSION])
  for (const tool of mcpContract.requiredTools) assert.ok(TOOL_NAMES.includes(tool), tool)
  for (const uri of mcpContract.requiredResources) assert.ok(RESOURCE_URIS.includes(uri), uri)
  assert.deepEqual(baseline.contract.exitCodes, { success: 0, userError: 1, tosRequired: 3 })
})

test('eval-det mcp suite still passes against the real CLI (the legacy contract is frozen)', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/eval-det.mjs'), '--suite', 'mcp', '--no-write'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env },
  })
  assert.equal(result.status, 0, 'eval-det mcp failed: ' + String(result.stderr).slice(-2000) + String(result.stdout).slice(-2000))
  assert.match(result.stdout, /PASS advisers eval:det/)
})
