import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { buildEvidencePack } from '../lib/evidence.js'
import { SqliteStore } from '../lib/sqlite.js'
import { TOOL_NAMES, createMcpServer } from '../lib/mcp-server.js'
import {
  CONTEXT_PACK_ITEM_VERIFICATION_BASIS,
  buildContextPack,
  writeContextPackDir,
} from '../lib/context-pack.js'

// 0.5.1 task-121 (M8 P0-A): advisers_pack_verify format dispatch.
//
// manifest.format 'advisers-context-pack' -> the context-pack offline verifier
// (additive payload: format/version/manifestDigest/expiresAt/expired/...);
// anything else keeps the legacy evidence-pack payload byte-for-byte. The tool
// count, names, descriptions and schemas are unchanged (8 tools / 5 resources).
// Temporary directories only; the real ~/.advisers is never touched.

const NOW = '2026-11-01T00:00:00.000Z'

function itemOf(kind, payload) {
  return {
    id: kind + '_1',
    kind,
    view: 'pending',
    verification: { basis: CONTEXT_PACK_ITEM_VERIFICATION_BASIS, resolved: 0, missing: 0, unverifiable: 0, notChecked: 0 },
    payload,
  }
}

function buildPack(overrides = {}) {
  return buildContextPack({
    subject: { kind: 'client', id: 'cl_wang', name: '王工' },
    items: [itemOf('commitment', { action: '发报价单', debtor: 'user', creditor: 'third:wang', status: 'open' })],
    recipient: 'Claude Code',
    purpose: 'external-review',
    expiresAt: '2099-01-01T00:00:00.000Z',
    generatedAt: '2026-11-22T00:00:00.000Z',
    autoAssembled: true,
    candidateCount: 1,
    excluded: { secrecy: 0, stale: 0, unsupportedKind: 0, notFound: 0 },
    ...overrides,
  })
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-pack-format-'))
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
  const audits = []
  const server = createMcpServer({
    store,
    ledger,
    version: '0.5.1-test',
    audit: (entry) => { audits.push(entry) },
    now: () => new Date('2026-11-22T03:00:00.000Z'),
  })
  const call = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  const callTool = async (name, args, id = 1) => {
    const response = await call('tools/call', { name, arguments: args }, id)
    const text = response.result?.content?.[0]?.text
    let data
    try { data = text === undefined ? undefined : JSON.parse(text) } catch { data = undefined }
    return { response, isError: response.result?.isError === true, text, data }
  }
  const cleanup = () => {
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
  return { root, store, ledger, commitment, audits, server, call, callTool, cleanup }
}

function writeEvidencePack(f, dir, { withReceipt = true } = {}) {
  const pack = buildEvidencePack({ store: f.store, ledger: f.ledger, ids: { commitments: [f.commitment.id] } })
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(pack.files)) writeFileSync(join(dir, name), content, { mode: 0o600 })
  if (withReceipt) writeFileSync(join(dir, 'receipt.docx'), Buffer.from('fake-docx'), { mode: 0o600 })
  return dir
}

test('tools/list is still the same 8 tools and pack_verify schema is unchanged', async () => {
  const f = fixture()
  try {
    const response = await f.call('tools/list')
    const tools = response.result.tools
    assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES])
    assert.equal(tools.length, 8)
    const packVerify = tools.find((tool) => tool.name === 'advisers_pack_verify')
    assert.equal(packVerify.annotations.readOnlyHint, true)
    assert.deepEqual(packVerify.inputSchema.required, ['dir'])
    assert.deepEqual(Object.keys(packVerify.inputSchema.properties), ['dir'])
    assert.equal(tools.some((tool) => /context/i.test(tool.name)), false, 'no new tool may be added')
  } finally { f.cleanup() }
})

test('a context pack dispatches to the context verifier and is verified without writing', async () => {
  const f = fixture()
  try {
    const dir = join(f.root, 'context-pack')
    const built = buildPack()
    writeContextPackDir(dir, built)
    const snapshot = () => {
      const out = {}
      for (const name of ['manifest.json', 'README.txt', 'SHA256SUMS']) out[name] = readFileSync(join(dir, name))
      return out
    }
    const beforeBytes = snapshot()
    const result = await f.callTool('advisers_pack_verify', { dir }, 51)
    assert.equal(result.isError, false)
    assert.equal(result.data.ok, true)
    assert.equal(result.data.format, 'advisers-context-pack')
    assert.equal(result.data.version, 1)
    assert.equal(result.data.fileCount, 3)
    assert.equal(result.data.checksumCount, 2)
    assert.equal(result.data.manifestDigest, built.manifestDigest)
    assert.equal(result.data.verificationBasis, 'local-checksums-only')
    assert.equal(result.data.expiresAt, '2099-01-01T00:00:00.000Z')
    assert.equal(result.data.expired, false)
    assert.deepEqual(result.data.errors, [])
    assert.ok(Array.isArray(result.data.warnings))
    assert.equal(typeof result.data.verifiedAt, 'string')
    assert.ok(!('receiptPresent' in result.data), 'a context pack has no receipt.docx branch')
    for (const name of Object.keys(beforeBytes)) assert.deepEqual(readFileSync(join(dir, name)), beforeBytes[name], 'pack_verify must not modify ' + name)
    assert.equal(JSON.stringify(result.data).includes(f.root), false, 'the payload must not leak the directory path')
    const audit = f.audits.filter((entry) => entry.action === 'mcp.pack.verify').pop()
    assert.equal(audit.actor, 'mcp')
    assert.equal(audit.allowed, true)
    assert.match(audit.reason, /3 files, 0 errors/)
  } finally { f.cleanup() }
})

test('a tampered or expired context pack still goes through the context verifier', async () => {
  const f = fixture()
  try {
    const dir = join(f.root, 'context-pack-tampered')
    writeContextPackDir(dir, buildPack())
    writeFileSync(join(dir, 'README.txt'), readFileSync(join(dir, 'README.txt'), 'utf8') + 'tampered\n')
    const tampered = await f.callTool('advisers_pack_verify', { dir }, 52)
    assert.equal(tampered.isError, false)
    assert.equal(tampered.data.ok, false)
    assert.equal(tampered.data.format, 'advisers-context-pack')
    assert.ok(tampered.data.errors.some((message) => /hash mismatch: README\.txt/.test(message)), JSON.stringify(tampered.data.errors))
    assert.equal(JSON.stringify(tampered.data).includes(f.root), false)
    const audit = f.audits.filter((entry) => entry.action === 'mcp.pack.verify').pop()
    assert.equal(audit.allowed, false)

    const expiredDir = join(f.root, 'context-pack-expired')
    writeContextPackDir(expiredDir, buildPack({ expiresAt: '2020-01-01T00:00:00.000Z' }))
    const expired = await f.callTool('advisers_pack_verify', { dir: expiredDir }, 53)
    assert.equal(expired.data.ok, true)
    assert.equal(expired.data.expired, true)
    assert.equal(expired.data.expiresAt, '2020-01-01T00:00:00.000Z')
    assert.ok(expired.data.warnings.some((warning) => /expired at/.test(warning)), JSON.stringify(expired.data.warnings))
  } finally { f.cleanup() }
})

test('the legacy evidence-pack payload is byte-compatible (same keys, same values)', async () => {
  const f = fixture()
  try {
    const dir = writeEvidencePack(f, join(f.root, 'receipt'))
    const result = await f.callTool('advisers_pack_verify', { dir }, 61)
    assert.equal(result.isError, false)
    // 0.5.0 payload shape and order: no new keys may appear on this branch.
    assert.deepEqual(Object.keys(result.data), ['ok', 'errors', 'files', 'fileCount', 'receiptPresent', 'extraFileCount', 'verifiedAt'])
    assert.equal(result.data.ok, true)
    assert.deepEqual(result.data.errors, [])
    assert.deepEqual([...result.data.files].sort(), ['README.txt', 'SHA256SUMS', 'manifest.json'])
    assert.equal(result.data.fileCount, 3)
    assert.equal(result.data.receiptPresent, true)
    assert.equal(result.data.extraFileCount, 0)
    assert.equal(typeof result.data.verifiedAt, 'string')
    assert.equal(JSON.stringify(result.data).includes(f.root), false)

    // Without receipt.docx the same legacy branch reports receiptPresent=false.
    const bare = writeEvidencePack(f, join(f.root, 'receipt-bare'), { withReceipt: false })
    const bareResult = await f.callTool('advisers_pack_verify', { dir: bare }, 62)
    assert.equal(bareResult.data.ok, true)
    assert.equal(bareResult.data.receiptPresent, false)
    assert.deepEqual(Object.keys(bareResult.data), Object.keys(result.data))
  } finally { f.cleanup() }
})

test('unreadable or missing directories keep the sanitized execution error', async () => {
  const f = fixture()
  try {
    const missingDir = join(f.root, 'no-such-pack')
    const missing = await f.callTool('advisers_pack_verify', { dir: missingDir }, 71)
    assert.equal(missing.isError, true)
    assert.match(missing.text, /pack directory not found/)
    assert.ok(!missing.text.includes(f.root))
    assert.ok(!missing.text.includes('no-such-pack'))
  } finally { f.cleanup() }
})
