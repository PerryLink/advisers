import assert from 'node:assert/strict'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildReceiptPack, sha256Hex } from '../lib/evidence.js'
import {
  RECEIPT_LIMIT_CODE,
  RECEIPT_LIMIT_DEFAULTS,
  parseReceiptSums,
  verifyReceiptPackDir,
} from '../lib/receipt-verify.js'

// 0.3.0 L3 (04-0.3-research §4.12 / 25-0.3.0-security-perf-robustness P0-L3):
// a receipt pack comes from a counterparty, so the verifier must cap entries,
// depth, single-file size, total size, SHA256SUMS size and manifest size and
// report the stable code E_RECEIPT_LIMIT with {limit, max, actual, file}.
// Normal v1/v1.1 packs must be unaffected, and hostile packs must be refused in
// ~O(limit) work instead of O(pack).

const FIXED_NOW = '2026-11-17T04:00:00.000Z'
const MiB = 1024 * 1024

function makeWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-limits-' + name + '-'))
  const work = join(root, 'work')
  mkdirSync(work)
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function sparseFile(file, bytes) {
  writeFileSync(file, '')
  const fd = openSync(file, 'r+')
  try { ftruncateSync(fd, bytes) } finally { closeSync(fd) }
}

function limitMessage(result) {
  return (result.errors ?? []).join(' | ')
}

async function buildNormalPack(ws) {
  const artifact = join(ws.work, 'quote.docx')
  writeFileSync(artifact, 'normal delivery bytes')
  const outDir = join(ws.root, 'normal-pack')
  const pack = await buildReceiptPack({
    deliveries: [{ id: 'del_normal', files: [artifact] }],
    verifyResults: { ok: true },
    now: FIXED_NOW,
    outDir,
    docxBuilder: false,
  })
  return { pack, outDir }
}

/** Minimal crafted pack: required files + SHA256SUMS with correct digests. */
function craftPack(dir, { manifestText, extraFiles = {} } = {}) {
  mkdirSync(dir, { recursive: true })
  const files = {
    'README.txt': 'receipt pack\n',
    'receipt.docx': Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]),
    ...extraFiles,
  }
  if (manifestText !== undefined) files['manifest.json'] = manifestText
  const lines = []
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
    lines.push(sha256Hex(content) + '  ' + name)
  }
  writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n')
  return dir
}

test('a normal receipt pack is unaffected and reports the effective limits', async () => {
  const ws = makeWorkspace('normal')
  try {
    const { outDir } = await buildNormalPack(ws)
    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, limitMessage(verified))
    assert.equal(verified.code, null)
    assert.equal(verified.limitViolation, null)
    assert.ok(verified.totalBytes > 0)
    assert.deepEqual(verified.limits, RECEIPT_LIMIT_DEFAULTS)
    assert.deepEqual(RECEIPT_LIMIT_DEFAULTS, {
      maxEntries: 5000,
      maxDepth: 8,
      maxFileBytes: 32 * MiB,
      maxTotalBytes: 256 * MiB,
      maxSumsBytes: 64 * 1024,
      maxManifestBytes: 1 * MiB,
    })
    assert.equal(parseReceiptSums(readFileSync(join(outDir, 'SHA256SUMS'), 'utf8')).errors.length, 0)
  } finally { ws.cleanup() }
})

test('too many pack entries is refused fast with E_RECEIPT_LIMIT metadata', () => {
  const ws = makeWorkspace('entries')
  try {
    const dir = join(ws.root, 'many')
    mkdirSync(dir)
    for (let index = 0; index < RECEIPT_LIMIT_DEFAULTS.maxEntries + 1; index++) {
      writeFileSync(join(dir, 'f' + index), '')
    }
    const startedAt = Date.now()
    const verified = verifyReceiptPackDir(dir)
    const elapsed = Date.now() - startedAt
    assert.equal(verified.ok, false)
    assert.equal(verified.code, RECEIPT_LIMIT_CODE)
    assert.equal(verified.limitViolation.limit, 'maxEntries')
    assert.equal(verified.limitViolation.max, RECEIPT_LIMIT_DEFAULTS.maxEntries)
    assert.equal(verified.limitViolation.actual, RECEIPT_LIMIT_DEFAULTS.maxEntries + 1)
    assert.ok(verified.limitViolation.file, 'the first offending path is reported')
    assert.match(limitMessage(verified), /E_RECEIPT_LIMIT: receipt pack entry count exceeded the limit 5000/)
    assert.ok(elapsed < 2000, 'hostile pack is refused quickly (' + elapsed + 'ms)')
  } finally { ws.cleanup() }
})

test('directory depth over MAX_PACK_DEPTH is refused', () => {
  const ws = makeWorkspace('depth')
  try {
    let deep = join(ws.root, 'deep')
    mkdirSync(deep)
    for (let index = 0; index < RECEIPT_LIMIT_DEFAULTS.maxDepth + 3; index++) {
      deep = join(deep, 'd' + index)
      mkdirSync(deep)
      writeFileSync(join(deep, 'marker'), 'x')
    }
    const verified = verifyReceiptPackDir(join(ws.root, 'deep'))
    assert.equal(verified.ok, false)
    assert.equal(verified.code, RECEIPT_LIMIT_CODE)
    assert.equal(verified.limitViolation.limit, 'maxDepth')
    assert.ok(verified.limitViolation.actual > RECEIPT_LIMIT_DEFAULTS.maxDepth)
  } finally { ws.cleanup() }
})

test('a single file over MAX_FILE_BYTES is refused without hashing it', () => {
  const ws = makeWorkspace('file')
  try {
    const dir = join(ws.root, 'big-file')
    mkdirSync(dir)
    sparseFile(join(dir, 'huge.bin'), RECEIPT_LIMIT_DEFAULTS.maxFileBytes + 1)
    const verified = verifyReceiptPackDir(dir)
    assert.equal(verified.ok, false)
    assert.equal(verified.limitViolation.limit, 'maxFileBytes')
    assert.equal(verified.limitViolation.actual, RECEIPT_LIMIT_DEFAULTS.maxFileBytes + 1)
  } finally { ws.cleanup() }
})

test('total pack bytes over MAX_TOTAL_BYTES is refused (zip-bomb style pack)', () => {
  const ws = makeWorkspace('total')
  try {
    const dir = join(ws.root, 'total-size')
    mkdirSync(dir)
    // Sparse files: the stat sizes add up but the test uses almost no disk.
    const each = 30 * MiB
    for (let index = 0; index < 9; index++) sparseFile(join(dir, 'part' + index + '.bin'), each)
    const verified = verifyReceiptPackDir(dir)
    assert.equal(verified.ok, false)
    assert.equal(verified.limitViolation.limit, 'maxTotalBytes')
    assert.ok(verified.limitViolation.actual > RECEIPT_LIMIT_DEFAULTS.maxTotalBytes)
  } finally { ws.cleanup() }
})

test('oversized SHA256SUMS is refused before it is parsed', () => {
  const ws = makeWorkspace('sums')
  try {
    const dir = join(ws.root, 'big-sums')
    mkdirSync(dir)
    const lines = []
    const perLine = '0'.repeat(64) + '  f' + '0'.repeat(8) + '\n'
    const count = Math.ceil((RECEIPT_LIMIT_DEFAULTS.maxSumsBytes + 1024) / perLine.length)
    for (let index = 0; index < count; index++) lines.push(perLine)
    writeFileSync(join(dir, 'SHA256SUMS'), lines.join(''))
    const verified = verifyReceiptPackDir(dir)
    assert.equal(verified.ok, false)
    assert.equal(verified.code, RECEIPT_LIMIT_CODE)
    assert.equal(verified.limitViolation.limit, 'maxSumsBytes')
  } finally { ws.cleanup() }
})

test('oversized manifest.json is refused before JSON.parse', () => {
  const ws = makeWorkspace('manifest')
  try {
    const dir = join(ws.root, 'big-manifest')
    const pad = 'x'.repeat(RECEIPT_LIMIT_DEFAULTS.maxManifestBytes + 1024)
    craftPack(dir, { manifestText: '{"pad":"' + pad + '"}' })
    const verified = verifyReceiptPackDir(dir)
    assert.equal(verified.ok, false)
    assert.equal(verified.code, RECEIPT_LIMIT_CODE)
    assert.equal(verified.limitViolation.limit, 'maxManifestBytes')
    assert.equal(verified.limitViolation.file, 'manifest.json')
  } finally { ws.cleanup() }
})

test('callers can tighten the limits (the future WebCrypto page shares them)', async () => {
  const ws = makeWorkspace('custom')
  try {
    const { outDir } = await buildNormalPack(ws)
    const verified = verifyReceiptPackDir(outDir, { limits: { maxEntries: 3 } })
    assert.equal(verified.ok, false)
    assert.equal(verified.code, RECEIPT_LIMIT_CODE)
    assert.equal(verified.limitViolation.limit, 'maxEntries')
    assert.equal(verified.limits.maxEntries, 3)
    assert.equal(verified.limits.maxFileBytes, RECEIPT_LIMIT_DEFAULTS.maxFileBytes, 'unset limits keep their defaults')
  } finally { ws.cleanup() }
})
