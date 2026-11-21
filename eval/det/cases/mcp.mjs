/**
 * MCP surface gate: the stdio server must keep a stable legacy contract.
 *
 * Checked: initialize echoes the legacy protocol version, tools/resources are
 * the documented set with deterministic order, a read tool returns JSON text,
 * and JSON-RPC rejection codes stay -32601/-32602/-32002/-32700.
 * Additive 0.3 fields (structuredContent, total/truncated, outputSchema) do not
 * fail these checks; removing/renaming an existing surface does.
 */
import { check, runMcp } from '../lib/harness.mjs'
import { readBaseline } from '../lib/baseline.mjs'
import { withSeededHome } from './_fixture.mjs'

function idsOf(list, key) {
  return (list ?? []).map((entry) => entry?.[key])
}

export default [
  {
    id: 'det.mcp.legacy-tools-resources',
    group: 'mcp',
    title: 'initialize / tools/list / resources/list keep the 2024-11-05 contract',
    async run() {
      const baseline = readBaseline()
      const contract = baseline.contract.mcp
      return withSeededHome('mcp', async (workdir) => {
        const checks = []
        const session = runMcp(workdir, [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-det', version: '1' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
          { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} },
          { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } },
        ])
        check(checks, 'session-exit-0', () => {
          if (session.status !== 0) throw new Error('exit ' + session.status + ': ' + session.stderr.slice(0, 300))
        })
        check(checks, 'stderr-empty', () => {
          if (session.stderr.trim() !== '') throw new Error(session.stderr.slice(0, 300))
        })
        check(checks, 'stdout-is-ndjson', () => {
          if (session.unparsable.length) throw new Error('unparsable line(s): ' + JSON.stringify(session.unparsable.slice(0, 2)))
        })
        check(checks, 'jsonrpc-2-0-envelope', () => {
          for (const response of session.responses) {
            if (response.jsonrpc !== '2.0') throw new Error('bad envelope: ' + JSON.stringify(response).slice(0, 200))
          }
        })
        check(checks, 'initialize-echoes-legacy-version', () => {
          const result = session.response(1)?.result
          const allowed = contract.initializeEchoVersions ?? ['2024-11-05']
          if (!allowed.includes(result?.protocolVersion)) throw new Error('protocolVersion=' + JSON.stringify(result?.protocolVersion))
          if (result?.serverInfo?.name !== 'advisers') throw new Error('serverInfo.name=' + JSON.stringify(result?.serverInfo?.name))
        })
        check(checks, 'capabilities-declare-tools-and-resources', () => {
          const capabilities = session.response(1)?.result?.capabilities
          if (typeof capabilities?.tools !== 'object' || capabilities?.tools === null) throw new Error('capabilities.tools missing')
          if (typeof capabilities?.resources !== 'object' || capabilities?.resources === null) throw new Error('capabilities.resources missing')
        })
        check(checks, 'required-tools-present', () => {
          const names = idsOf(session.response(2)?.result?.tools, 'name')
          const missing = (contract.requiredTools ?? []).filter((name) => !names.includes(name))
          if (missing.length) throw new Error('missing tool(s): ' + missing.join(', '))
          if (new Set(names).size !== names.length) throw new Error('duplicate tool name in tools/list')
        })
        check(checks, 'tools-are-described', () => {
          for (const tool of session.response(2)?.result?.tools ?? []) {
            if (typeof tool.name !== 'string' || !tool.name) throw new Error('tool without name')
            if (typeof tool.description !== 'string' || !tool.description) throw new Error(tool.name + ' has no description')
            if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) throw new Error(tool.name + ' has no inputSchema')
          }
        })
        check(checks, 'tools-list-order-deterministic', () => {
          const first = JSON.stringify(session.response(2)?.result?.tools)
          const second = JSON.stringify(session.response(4)?.result?.tools)
          if (first !== second) throw new Error('tools/list is not stable within one session')
        })
        check(checks, 'required-resources-present', () => {
          const uris = idsOf(session.response(3)?.result?.resources, 'uri')
          const missing = (contract.requiredResources ?? []).filter((uri) => !uris.includes(uri))
          if (missing.length) throw new Error('missing resource(s): ' + missing.join(', '))
          for (const resource of session.response(3)?.result?.resources ?? []) {
            if (typeof resource.uri !== 'string' || resource.uri.indexOf('advisers://') !== 0) throw new Error('bad resource uri: ' + JSON.stringify(resource.uri))
            if (typeof resource.name !== 'string' || !resource.name) throw new Error(resource.uri + ' has no name')
            if (typeof resource.mimeType !== 'string' || !resource.mimeType) throw new Error(resource.uri + ' has no mimeType')
          }
        })
        check(checks, 'resources-list-order-deterministic', () => {
          const first = JSON.stringify(session.response(3)?.result?.resources)
          const second = JSON.stringify(session.response(5)?.result?.resources)
          if (first !== second) throw new Error('resources/list is not stable within one session')
        })
        check(checks, 'read-tool-returns-json-text', () => {
          const result = session.response(6)?.result
          if (result?.isError === true) throw new Error('advisers_today returned isError')
          const text = result?.content?.[0]?.text
          if (typeof text !== 'string') throw new Error('content[0].text is not a string')
          let payload
          try { payload = JSON.parse(text) } catch (error) { throw new Error('content[0].text is not JSON: ' + String(error.message)) }
          if (typeof payload?.open !== 'number') throw new Error('today payload has no numeric open: ' + JSON.stringify(payload).slice(0, 200))
          if (!Array.isArray(payload?.commitments)) throw new Error('today payload has no commitments array')
        })
        check(checks, 'no-network', () => {
          if (session.network.length) throw new Error(JSON.stringify(session.network))
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.mcp.rejection-codes',
    group: 'mcp',
    title: 'JSON-RPC rejection codes stay -32601 / -32602 / -32002 / -32700',
    async run() {
      return withSeededHome('mcp-codes', async (workdir) => {
        const checks = []
        const session = runMcp(
          workdir,
          [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-det', version: '1' } } },
            { jsonrpc: '2.0', id: 2, method: 'does/not/exist', params: {} },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
            { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'advisers://does-not-exist' } },
            { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'advisers_evidence', arguments: {} } },
          ],
          { rawLines: ['{not json'] },
        )
        check(checks, 'session-exit-0', () => {
          if (session.status !== 0) throw new Error('exit ' + session.status)
        })
        check(checks, 'unknown-method-32601', () => {
          const code = session.response(2)?.error?.code
          if (code !== -32601) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'unknown-tool-32602', () => {
          const code = session.response(3)?.error?.code
          if (code !== -32602) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'unknown-resource-32002', () => {
          const code = session.response(4)?.error?.code
          if (code !== -32002) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'invalid-tool-args-32602', () => {
          const code = session.response(5)?.error?.code
          if (code !== -32602) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'parse-error-32700', () => {
          const response = session.responses.find((item) => item?.error?.code === -32700)
          if (!response) throw new Error('no -32700 response for an invalid JSON line')
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.mcp.modern-dual-era',
    group: 'mcp',
    title: 'modern 2026-07-28 era answers behind the v2 envelope with byte-identical payloads (dual-era)',
    async run() {
      const baseline = readBaseline()
      const contract = baseline.contract.mcp
      // Modern era shapes are hard-coded here on purpose: they are a 0.4.0
      // additive contract and must not move by editing eval/det/baseline.json.
      const MODERN_VERSION = '2026-07-28'
      const MODERN_TTL_MS = 300000
      const MODERN_META = {
        'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      }
      const modernParams = (params = {}) => ({ ...params, _meta: MODERN_META })
      return withSeededHome('mcp-modern', async (workdir) => {
        const checks = []
        const session = runMcp(workdir, [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-det', version: '1' } } },
          { jsonrpc: '2.0', id: 2, method: 'server/discover', params: modernParams() },
          { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 4, method: 'tools/list', params: modernParams() },
          { jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} },
          { jsonrpc: '2.0', id: 6, method: 'resources/list', params: modernParams() },
          { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'advisers://today' } },
          { jsonrpc: '2.0', id: 8, method: 'resources/read', params: modernParams({ uri: 'advisers://today' }) },
          { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } },
          { jsonrpc: '2.0', id: 10, method: 'tools/call', params: modernParams({ name: 'advisers_today', arguments: {} }) },
          { jsonrpc: '2.0', id: 11, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25', 'io.modelcontextprotocol/clientCapabilities': {} } } },
          { jsonrpc: '2.0', id: 12, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION } } },
          { jsonrpc: '2.0', id: 13, method: 'ping', params: modernParams() },
          { jsonrpc: '2.0', id: 14, method: 'tools/list', params: modernParams({ cursor: 'next' }) },
          { jsonrpc: '2.0', id: 15, method: 'resources/read', params: modernParams({ uri: 'advisers://does-not-exist' }) },
          { jsonrpc: '2.0', id: 16, method: 'resources/read', params: { uri: 'advisers://does-not-exist' } },
          { jsonrpc: '2.0', method: 'notifications/initialized', params: modernParams() },
          { jsonrpc: '2.0', id: 17, method: 'tools/list', params: modernParams() },
        ])
        check(checks, 'session-exit-0', () => {
          if (session.status !== 0) throw new Error('exit ' + session.status + ': ' + session.stderr.slice(0, 300))
        })
        check(checks, 'stderr-empty', () => {
          if (session.stderr.trim() !== '') throw new Error(session.stderr.slice(0, 300))
        })
        check(checks, 'stdout-is-ndjson', () => {
          if (session.unparsable.length) throw new Error('unparsable line(s): ' + JSON.stringify(session.unparsable.slice(0, 2)))
        })
        check(checks, 'modern-notification-not-answered', () => {
          if (session.responses.length !== 17) throw new Error('expected 17 responses (one per request with id), got ' + session.responses.length)
          if (session.responses.some((response) => response?.id === null || response?.id === undefined)) throw new Error('a notification was answered')
        })
        check(checks, 'modern-discover-envelope', () => {
          const result = session.response(2)?.result
          if (result?.resultType !== 'complete') throw new Error('resultType=' + JSON.stringify(result?.resultType))
          if (!Array.isArray(result?.supportedVersions) || !result.supportedVersions.includes(MODERN_VERSION)) throw new Error('supportedVersions=' + JSON.stringify(result?.supportedVersions))
          if (result?.ttlMs !== MODERN_TTL_MS) throw new Error('ttlMs=' + JSON.stringify(result?.ttlMs))
          if (result?.cacheScope !== 'public') throw new Error('cacheScope=' + JSON.stringify(result?.cacheScope))
          if (result?._meta?.['io.modelcontextprotocol/serverInfo']?.name !== 'advisers') throw new Error('serverInfo=' + JSON.stringify(result?._meta))
        })
        check(checks, 'modern-tools-list-same-catalogue', () => {
          const legacy = session.response(3)?.result?.tools
          const modern = session.response(4)?.result
          if (modern?.resultType !== 'complete' || modern?.ttlMs !== MODERN_TTL_MS || modern?.cacheScope !== 'public') throw new Error('bad modern tools/list envelope: ' + JSON.stringify(Object.keys(modern ?? {})))
          if (JSON.stringify(modern?.tools) !== JSON.stringify(legacy)) throw new Error('modern tools/list payload differs from legacy')
          const names = (modern?.tools ?? []).map((tool) => tool?.name)
          const missing = (contract.requiredTools ?? []).filter((name) => !names.includes(name))
          if (missing.length) throw new Error('missing tool(s): ' + missing.join(', '))
        })
        check(checks, 'modern-resources-list-same-catalogue', () => {
          const legacy = session.response(5)?.result?.resources
          const modern = session.response(6)?.result
          if (modern?.resultType !== 'complete' || modern?.ttlMs !== MODERN_TTL_MS || modern?.cacheScope !== 'public') throw new Error('bad modern resources/list envelope')
          if (JSON.stringify(modern?.resources) !== JSON.stringify(legacy)) throw new Error('modern resources/list payload differs from legacy')
          const uris = (modern?.resources ?? []).map((resource) => resource?.uri)
          const missing = (contract.requiredResources ?? []).filter((uri) => !uris.includes(uri))
          if (missing.length) throw new Error('missing resource(s): ' + missing.join(', '))
        })
        check(checks, 'modern-resource-read-same-text', () => {
          const legacy = session.response(7)?.result?.contents?.[0]?.text
          const modern = session.response(8)?.result
          if (modern?.resultType !== 'complete' || modern?.ttlMs !== 0 || modern?.cacheScope !== 'private') throw new Error('bad modern resources/read envelope')
          if (typeof modern?.contents?.[0]?.text !== 'string' || modern.contents[0].text !== legacy) throw new Error('modern resources/read text is not byte-identical to legacy')
        })
        check(checks, 'modern-tool-call-same-text', () => {
          const legacy = session.response(9)?.result?.content?.[0]?.text
          const modern = session.response(10)?.result
          if (modern?.resultType !== 'complete') throw new Error('resultType=' + JSON.stringify(modern?.resultType))
          if (Object.hasOwn(modern ?? {}, 'ttlMs')) throw new Error('tools/call must not be cacheable (ttlMs present)')
          if (modern?.isError !== false) throw new Error('isError=' + JSON.stringify(modern?.isError))
          if (typeof modern?.content?.[0]?.text !== 'string' || modern.content[0].text !== legacy) throw new Error('modern tools/call text is not byte-identical to legacy')
        })
        check(checks, 'unsupported-version-32022', () => {
          const error = session.response(11)?.error
          if (error?.code !== -32022) throw new Error('code=' + JSON.stringify(error?.code))
          if (!(error?.data?.supported ?? []).includes(MODERN_VERSION)) throw new Error('data.supported=' + JSON.stringify(error?.data?.supported))
          if (error?.data?.requested !== '2025-11-25') throw new Error('data.requested=' + JSON.stringify(error?.data?.requested))
        })
        check(checks, 'missing-client-capabilities-32602', () => {
          const code = session.response(12)?.error?.code
          if (code !== -32602) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'modern-ping-32601', () => {
          const code = session.response(13)?.error?.code
          if (code !== -32601) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'modern-cursor-32602', () => {
          const code = session.response(14)?.error?.code
          if (code !== -32602) throw new Error('code=' + JSON.stringify(code))
        })
        check(checks, 'unknown-resource-error-split', () => {
          const modern = session.response(15)?.error?.code
          const legacy = session.response(16)?.error?.code
          if (modern !== -32602) throw new Error('modern unknown resource code=' + JSON.stringify(modern))
          if (legacy !== -32002) throw new Error('legacy unknown resource code=' + JSON.stringify(legacy))
        })
        check(checks, 'modern-marker-answered', () => {
          const result = session.response(17)?.result
          if (result?.resultType !== 'complete') throw new Error('tools/list after a notification did not answer with resultType=complete')
        })
        check(checks, 'no-network', () => {
          if (session.network.length) throw new Error(JSON.stringify(session.network))
        })
        return { checks }
      })
    },
  },
]
