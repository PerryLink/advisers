import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import {
  DEFAULT_MAX_EVIDENCE_ENTRIES,
  EvidencePackLimitError,
  RECEIPT_MANIFEST_FORMAT,
  RECEIPT_MANIFEST_VERSION,
  RECEIPT_REQUIRED_FILES,
  buildEvidencePack,
  buildReceiptPack,
  sha256Hex,
  verifyPack,
} from '../lib/evidence.js'
import { parseReceiptSums, verifyReceiptPackDir } from '../lib/receipt-verify.js'

const FIXED_NOW = '2026-11-17T04:00:00.000Z'
const QUOTE = '周五前把报价发给王工'
const QUOTE_DOCX = Buffer.from('PK fake docx delivery bytes for quote.docx')
const LEDGER_XLSX = Buffer.from('fake xlsx delivery bytes for ledger.xlsx')

function makeWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-' + name + '-'))
  const work = join(root, 'work')
  mkdirSync(work)
  return {
    root,
    work,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeArtifact(work, name, content) {
  const file = join(work, name)
  writeFileSync(file, content)
  return file
}

/** Two deliveries: one path-string artifact and one {sourcePath} artifact. */
function deliveryInputs(work) {
  const quote = writeArtifact(work, 'quote.docx', QUOTE_DOCX)
  const ledger = writeArtifact(work, 'ledger.xlsx', LEDGER_XLSX)
  return [
    {
      id: 'del_alpha',
      title: '报价确认单',
      tool: 'deliver:confirmation',
      createdAt: '2026-11-17T03:00:00.000Z',
      validation: 'docx',
      files: [quote],
    },
    {
      id: 'del_beta',
      title: '对账单',
      tool: 'deliver:statement',
      files: [{ sourcePath: ledger }],
    },
  ]
}

function sampleEvidence() {
  return {
    summary: {
      format: 'advisers-evidence-pack',
      version: 1,
      entries: [
        {
          kind: 'commitment',
          id: 'cm_1',
          found: true,
          sources: [
            {
              sessionId: 'conv-1',
              turnId: 'turn_1',
              quote: QUOTE,
              quoteChars: Array.from(QUOTE).length,
              truncated: false,
              quoteSha256: sha256Hex(QUOTE),
            },
          ],
          missing: [],
        },
      ],
    },
  }
}

function buildSamplePack(work, outDir, overrides = {}) {
  return buildReceiptPack({
    deliveries: deliveryInputs(work),
    evidence: sampleEvidence(),
    verifyResults: [
      { tool: 'advisers verify', ok: true, checks: [{ id: 'opc.required-parts', ok: true, severity: 'blocker', detail: 'ok' }] },
      { ok: true },
    ],
    env: {
      advisersVersion: '0.2.0-test',
      nodeVersion: 'v-test',
      templateName: 'weekly',
      templateVersion: '1',
      command: 'advisers deliver --out /tmp/secret/file.docx',
    },
    recipient: { name: '王工', email: 'wang@example.com' },
    now: FIXED_NOW,
    outDir,
    // Keep the unit suite fast and dependency-free: exercise the built-in
    // portable DOCX writer. The optional advisers-office builder is covered by
    // the CLI integration path.
    docxBuilder: false,
    ...overrides,
  })
}

function copyPack(src, suffix) {
  const dest = src + '-' + suffix
  cpSync(src, dest, { recursive: true })
  return dest
}

function hex64(char) {
  return char.repeat(64)
}

/** Rewrite manifest.json and re-seal its SHA256SUMS line, simulating a forger
 * who can recompute digests but cannot produce a valid schema. */
function resealManifest(packDir, mutate) {
  const manifestPath = join(packDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  mutate(manifest)
  const text = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(manifestPath, text)
  const sumsPath = join(packDir, 'SHA256SUMS')
  const digest = sha256Hex(text)
  const lines = readFileSync(sumsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (line.endsWith('  manifest.json') ? digest + '  manifest.json' : line))
  writeFileSync(sumsPath, lines.join('\n') + '\n')
  return text
}

function expectVerifyFailure(packDir, needle) {
  const result = verifyReceiptPackDir(packDir)
  assert.equal(result.ok, false, 'verification must fail for ' + packDir)
  assert.ok(
    result.errors.some((error) => error.includes(needle)),
    'expected an error containing "' + needle + '", got: ' + result.errors.join(' | '),
  )
  return result
}

// ---------------------------------------------------------------------------
// build: completeness, checksums, modes, privacy
// ---------------------------------------------------------------------------

test('buildReceiptPack writes a complete hash-covered receipt pack', async () => {
  const ws = makeWorkspace('complete')
  try {
    const outDir = join(ws.root, 'pack')
    const pack = await buildSamplePack(ws.work, outDir)
    assert.deepEqual(Object.keys(pack.files), [
      'README.txt',
      'SHA256SUMS',
      'deliveries/del_alpha/quote.docx',
      'deliveries/del_beta/ledger.xlsx',
      'manifest.json',
      'receipt.docx',
    ])
    assert.equal(pack.summary.fileCount, 5)
    assert.equal(pack.summary.deliveryCount, 2)
    assert.equal(pack.summary.verifyStatus, 'passed')
    assert.equal(pack.summary.diskVerified, true)
    assert.equal(pack.summary.outDir, outDir)

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.format, RECEIPT_MANIFEST_FORMAT)
    assert.equal(manifest.version, RECEIPT_MANIFEST_VERSION)
    assert.equal(manifest.createdAt, FIXED_NOW)
    assert.equal(manifest.generator.advisersVersion, '0.2.0-test')
    assert.equal(manifest.generator.nodeVersion, 'v-test')
    assert.equal(manifest.generator.templateName, 'weekly')
    assert.equal(manifest.generator.templateVersion, '1')
    assert.equal(manifest.generator.command, 'advisers deliver --out <path>')
    assert.deepEqual(manifest.recipient, { name: '王工', email: 'wang@example.com', note: null })
    assert.equal(manifest.verifyStatus, 'passed')
    assert.equal(manifest.verify.length, 2)
    assert.equal(manifest.fileCount, 5)

    assert.equal(manifest.deliveries.length, 2)
    const quoteFile = manifest.deliveries[0].files[0]
    const ledgerFile = manifest.deliveries[1].files[0]
    assert.equal(quoteFile.path, 'deliveries/del_alpha/quote.docx')
    assert.equal(quoteFile.size, QUOTE_DOCX.length)
    assert.equal(quoteFile.sha256, sha256Hex(QUOTE_DOCX))
    assert.equal(ledgerFile.path, 'deliveries/del_beta/ledger.xlsx')
    assert.equal(ledgerFile.sha256, sha256Hex(LEDGER_XLSX))
    assert.deepEqual(readFileSync(join(outDir, 'deliveries/del_alpha/quote.docx')), QUOTE_DOCX)
    assert.deepEqual(readFileSync(join(outDir, 'deliveries/del_beta/ledger.xlsx')), LEDGER_XLSX)

    const receiptBytes = readFileSync(join(outDir, 'receipt.docx'))
    assert.equal(manifest.receipt.path, 'receipt.docx')
    assert.equal(manifest.receipt.size, receiptBytes.length)
    assert.equal(manifest.receipt.sha256, sha256Hex(receiptBytes))
    assert.equal(receiptBytes[0], 0x50)
    assert.equal(receiptBytes[1], 0x4b)
    assert.ok(receiptBytes.includes(Buffer.from('word/document.xml')), 'receipt.docx must be a real DOCX')

    assert.equal(manifest.evidence.entryCount, 1)
    assert.equal(manifest.evidence.entries[0].kind, 'commitment')
    assert.equal(manifest.evidence.entries[0].sources[0].quoteSha256, sha256Hex(QUOTE))

    // SHA256SUMS covers every pack file except itself.
    const parsed = parseReceiptSums(readFileSync(join(outDir, 'SHA256SUMS'), 'utf8'))
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.entries.size, 5)
    for (const required of RECEIPT_REQUIRED_FILES) assert.ok(parsed.entries.has(required), required)
    assert.equal(parsed.entries.has('SHA256SUMS'), false)
    for (const [name, digest] of parsed.entries) {
      const bytes = readFileSync(join(outDir, ...name.split('/')))
      assert.equal(digest, sha256Hex(bytes), name)
    }

    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
    assert.deepEqual(verified.errors, [])
    assert.equal(verified.checksumCount, 5)
    assert.equal(verified.fileCount, 6)
    assert.ok(verified.warnings.some((warning) => /not externally anchored/.test(warning)))

    // Privacy: no absolute paths, no cwd/temp leaks.
    for (const name of ['manifest.json', 'README.txt', 'SHA256SUMS']) {
      const text = readFileSync(join(outDir, name), 'utf8')
      assert.equal(text.includes(ws.root), false, name + ' must not leak the workspace path')
      assert.equal(text.includes(tmpdir()), false, name + ' must not leak the temp root')
      assert.equal(/\/mnt\/|[A-Za-z]:\\/.test(text), false, name + ' must not contain absolute paths')
    }
    assert.match(readFileSync(join(outDir, 'README.txt'), 'utf8'), /NONE - this pack is not externally anchored/)

    // 0600 for every pack file / 0700 for the directory (POSIX only).
    if (process.platform !== 'win32') {
      assert.equal(statSync(outDir).mode & 0o777, 0o700)
      for (const name of ['manifest.json', 'README.txt', 'receipt.docx', 'SHA256SUMS', 'deliveries/del_alpha/quote.docx']) {
        assert.equal(statSync(join(outDir, ...name.split('/'))).mode & 0o777, 0o600, name + ' must be 0600')
      }
    }

  } finally {
    ws.cleanup()
  }
})

test('SHA256SUMS is coreutils-compatible when sha256sum exists', async () => {
  const ws = makeWorkspace('sums')
  try {
    if (process.platform === 'win32') return
    const outDir = join(ws.root, 'pack')
    await buildSamplePack(ws.work, outDir)
    let stdout = ''
    try {
      stdout = execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: outDir, encoding: 'utf8' })
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    assert.equal((stdout.match(/: OK$/gm) || []).length, 5, stdout)
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// tamper / missing / extra files
// ---------------------------------------------------------------------------

test('verifyReceiptPackDir detects tampering, missing files and extra files', async () => {
  const ws = makeWorkspace('tamper')
  try {
    const base = join(ws.root, 'base')
    await buildSamplePack(ws.work, base)

    // Any edit to a covered file must flip verification to false.
    const tamperCases = [
      ['manifest', (dir) => appendFileSync(join(dir, 'manifest.json'), '\n'), 'hash mismatch: manifest.json'],
      ['readme', (dir) => appendFileSync(join(dir, 'README.txt'), 'tampered'), 'hash mismatch: README.txt'],
      ['receipt', (dir) => appendFileSync(join(dir, 'receipt.docx'), 'x'), 'hash mismatch: receipt.docx'],
      [
        'delivery',
        (dir) => appendFileSync(join(dir, 'deliveries/del_alpha/quote.docx'), 'x'),
        'hash mismatch: deliveries/del_alpha/quote.docx',
      ],
    ]
    for (const [suffix, mutate, needle] of tamperCases) {
      const dir = copyPack(base, suffix)
      mutate(dir)
      expectVerifyFailure(dir, needle)
    }

    // A flipped digest line makes the listed file fail (SHA256SUMS still parses).
    const flippedDir = copyPack(base, 'flipped')
    const sumsText = readFileSync(join(flippedDir, 'SHA256SUMS'), 'utf8')
    const firstLine = sumsText.split('\n')[0]
    const [firstHash, firstName] = firstLine.split('  ')
    const flipped = (firstHash[0] === '0' ? '1' : '0') + firstHash.slice(1)
    writeFileSync(join(flippedDir, 'SHA256SUMS'), sumsText.replace(firstLine, flipped + '  ' + firstName))
    expectVerifyFailure(flippedDir, 'hash mismatch: ' + firstName)

    // Missing files are reported, never silently ignored.
    const missingDelivery = copyPack(base, 'missing-delivery')
    unlinkSync(join(missingDelivery, 'deliveries/del_beta/ledger.xlsx'))
    expectVerifyFailure(missingDelivery, 'missing file: deliveries/del_beta/ledger.xlsx')

    const missingReceipt = copyPack(base, 'missing-receipt')
    unlinkSync(join(missingReceipt, 'receipt.docx'))
    expectVerifyFailure(missingReceipt, 'missing file: receipt.docx')

    const missingSums = copyPack(base, 'missing-sums')
    unlinkSync(join(missingSums, 'SHA256SUMS'))
    expectVerifyFailure(missingSums, 'missing file: SHA256SUMS')

    // An unlisted file smuggled into the directory must fail verification.
    const extra = copyPack(base, 'extra')
    writeFileSync(join(extra, 'smuggled.txt'), 'x')
    expectVerifyFailure(extra, 'file not covered by SHA256SUMS: smuggled.txt')

    // SHA256SUMS itself must stay strict: no traversal, duplicates or self-listing.
    const unsafe = copyPack(base, 'unsafe')
    appendFileSync(join(unsafe, 'SHA256SUMS'), hex64('a') + '  ../escape.txt\n')
    expectVerifyFailure(unsafe, 'unsafe path in SHA256SUMS')

    const duplicate = copyPack(base, 'duplicate')
    appendFileSync(join(duplicate, 'SHA256SUMS'), readFileSync(join(duplicate, 'SHA256SUMS'), 'utf8').split('\n')[0] + '\n')
    expectVerifyFailure(duplicate, 'duplicate entry in SHA256SUMS')

    const selfListing = copyPack(base, 'self')
    appendFileSync(join(selfListing, 'SHA256SUMS'), hex64('b') + '  SHA256SUMS\n')
    expectVerifyFailure(selfListing, 'SHA256SUMS must not list itself')

    // Symlinks are rejected (a pack must be self-contained bytes).
    if (process.platform !== 'win32') {
      const symlinks = copyPack(base, 'symlink')
      const { symlinkSync } = await import('node:fs')
      symlinkSync(join(ws.work, 'quote.docx'), join(symlinks, 'link.docx'))
      expectVerifyFailure(symlinks, 'symbolic links are not allowed')
    }

    // Non-existent / non-directory paths fail cleanly.
    const missing = verifyReceiptPackDir(join(ws.root, 'does-not-exist'))
    assert.equal(missing.ok, false)
    assert.ok(missing.errors.some((error) => error.includes('not found')))
    const notDirectory = verifyReceiptPackDir(writeArtifact(ws.work, 'plain.txt', 'x'))
    assert.equal(notDirectory.ok, false)
    assert.ok(notDirectory.errors.some((error) => error.includes('not a directory')))
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// schema drift with recomputed checksums
// ---------------------------------------------------------------------------

test('verifyReceiptPackDir validates the manifest schema even when checksums are recomputed', async () => {
  const ws = makeWorkspace('schema')
  try {
    const base = join(ws.root, 'base')
    await buildSamplePack(ws.work, base)
    const cases = [
      ['format', (manifest) => { manifest.format = 'evil-pack' }, 'manifest.format'],
      ['version', (manifest) => { manifest.version = 2 }, 'manifest.version'],
      ['path-traversal', (manifest) => { manifest.deliveries[0].files[0].path = '../escape.docx' }, 'safe relative path'],
      ['receipt-digest', (manifest) => { manifest.receipt.sha256 = hex64('f') }, 'manifest digest disagrees with SHA256SUMS for receipt.docx'],
      ['entry-count', (manifest) => { manifest.evidence.entryCount += 1 }, 'entryCount'],
      ['verify-status', (manifest) => { manifest.verifyStatus = 'failed' }, 'verifyStatus'],
      ['file-count', (manifest) => { manifest.fileCount = 99 }, 'fileCount'],
      ['quote-digest', (manifest) => { manifest.evidence.entries[0].sources[0].quoteSha256 = hex64('f') }, 'quoteSha256 mismatch'],
      ['delivery-size', (manifest) => { manifest.deliveries[0].files[0].size += 1 }, 'size disagrees with the file on disk'],
      [
        'duplicate-path',
        (manifest) => { manifest.deliveries[1].files[0].path = manifest.deliveries[0].files[0].path },
        'duplicate delivery file path',
      ],
    ]
    for (const [suffix, mutate, needle] of cases) {
      const dir = copyPack(base, suffix)
      resealManifest(dir, mutate)
      expectVerifyFailure(dir, needle)
    }
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// optional external timestamp anchors
// ---------------------------------------------------------------------------

test('anchors are validated against the final file bytes', async () => {
  const ws = makeWorkspace('anchors')
  try {
    const work = ws.work
    const quotePath = writeArtifact(work, 'anchored.docx', Buffer.from('anchored artifact bytes'))
    const quoteSha = sha256Hex(readFileSync(quotePath))
    const deliveries = [{ id: 'del_anchor', title: '带锚交付', files: [quotePath] }]
    const anchor = {
      file: 'deliveries/del_anchor/anchored.docx',
      fileSha256: quoteSha,
      adapterId: 'free-tsa',
      issuedAt: '2026-11-17T03:30:00.000Z',
      proof: Buffer.from('fake-rfc3161-token').toString('base64'),
    }
    const outDir = join(ws.root, 'anchored-pack')
    const pack = await buildReceiptPack({
      deliveries,
      verifyResults: { ok: true },
      anchors: [anchor],
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.anchors.length, 1)
    assert.equal(manifest.anchors[0].fileSha256, quoteSha)
    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
    assert.equal(verified.warnings.some((warning) => /not externally anchored/.test(warning)), false)
    assert.equal(pack.summary.anchored, true)

    // A wrong digest or a forbidden target is rejected at build time.
    await assert.rejects(
      buildReceiptPack({ deliveries, anchors: [{ ...anchor, fileSha256: hex64('f') }], now: FIXED_NOW, docxBuilder: false }),
      /does not match the final bytes/,
    )
    await assert.rejects(
      buildReceiptPack({ deliveries, anchors: [{ ...anchor, file: 'manifest.json' }], now: FIXED_NOW, docxBuilder: false }),
      /must be a delivery file or receipt\.docx/,
    )

    // A forger who re-seals the manifest still fails the anchor cross-check.
    const tampered = copyPack(outDir, 'anchor-drift')
    resealManifest(tampered, (next) => { next.anchors[0].fileSha256 = hex64('f') })
    expectVerifyFailure(tampered, 'anchor fileSha256 disagrees with SHA256SUMS')
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// input validation / safe output writer
// ---------------------------------------------------------------------------

test('buildReceiptPack validates inputs and never clobbers a non-empty outDir', async () => {
  const ws = makeWorkspace('inputs')
  try {
    await assert.rejects(buildReceiptPack({ deliveries: [] }), /requires at least one delivery/)
    await assert.rejects(
      buildReceiptPack({ deliveries: [{ id: 'del_missing', files: [join(ws.work, 'nope.docx')] }] }),
      /not readable/,
    )
    const file = writeArtifact(ws.work, 'ok.docx', Buffer.from('ok'))
    await assert.rejects(
      buildReceiptPack({ deliveries: [{ id: 'del_ok', files: [file] }], verifyResults: [{ ok: 'yes' }] }),
      /ok must be a boolean/,
    )

    // Without outDir nothing is written; the caller gets bytes/strings and the mode contract.
    const inMemory = await buildReceiptPack({
      deliveries: [{ id: 'del_ok', files: [file] }],
      verifyResults: { ok: true },
      now: FIXED_NOW,
      docxBuilder: false,
    })

    // A caller-supplied builder is honoured (and still must produce a DOCX).
    const custom = await buildReceiptPack({
      deliveries: [{ id: 'del_ok', files: [file] }],
      verifyResults: { ok: true },
      now: FIXED_NOW,
      docxBuilder: () => inMemory.files['receipt.docx'],
    })
    assert.deepEqual(custom.files['receipt.docx'], inMemory.files['receipt.docx'])
    await assert.rejects(
      buildReceiptPack({ deliveries: [{ id: 'del_ok', files: [file] }], docxBuilder: () => Buffer.from('not a zip') }),
      /did not return a ZIP/,
    )
    assert.equal(typeof inMemory.files['SHA256SUMS'], 'string')
    assert.ok(Buffer.isBuffer(inMemory.files['receipt.docx']))
    assert.equal(inMemory.summary.outDir, undefined)
    assert.equal(inMemory.summary.fileMode, 0o600)

    // Existing non-empty directory: refuse, then move aside (never delete).
    const outDir = join(ws.root, 'occupied')
    mkdirSync(outDir)
    writeFileSync(join(outDir, 'keep.txt'), 'keep me')
    await assert.rejects(
      buildReceiptPack({ deliveries: [{ id: 'del_ok', files: [file] }], now: FIXED_NOW, outDir, docxBuilder: false }),
      /not empty/,
    )
    assert.equal(readFileSync(join(outDir, 'keep.txt'), 'utf8'), 'keep me')
    const rebuilt = await buildReceiptPack({
      deliveries: [{ id: 'del_ok', files: [file] }],
      verifyResults: { ok: true },
      now: FIXED_NOW,
      outDir,
      overwrite: true,
      docxBuilder: false,
    })
    assert.equal(rebuilt.summary.diskVerified, true)
    assert.equal(typeof rebuilt.summary.replaced, 'string')
    assert.ok(readdirSync(join(ws.root)).some((name) => name.startsWith('occupied.replaced-')))
    assert.equal(readFileSync(join(rebuilt.summary.replaced, 'keep.txt'), 'utf8'), 'keep me')
    assert.equal(verifyReceiptPackDir(outDir).ok, true)
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// privacy: receipt packs keep references and capped quotes, never full bodies
// ---------------------------------------------------------------------------

test('receipt evidence keeps only capped quotes and no transcript bodies', async () => {
  const ws = makeWorkspace('privacy')
  try {
    const secretBody = '客户正文全文标记：这段内容绝不能出现在回执包里'
    const longQuote = '张'.repeat(700)
    const file = writeArtifact(ws.work, 'deliverable.docx', Buffer.from('deliverable'))
    const evidence = {
      summary: {
        format: 'advisers-evidence-pack',
        version: 1,
        entries: [
          {
            kind: 'commitment',
            id: 'cm_secret',
            found: true,
            sources: [
              {
                sessionId: 'conv-1',
                turnId: 'turn_1',
                quote: longQuote,
                turn: { id: 'turn_1', conversationId: 'conv-1', seq: 3, role: 'user', content: longQuote + secretBody },
              },
            ],
            missing: [],
          },
        ],
      },
    }
    const outDir = join(ws.root, 'pack')
    const pack = await buildReceiptPack({
      deliveries: [{ id: 'del_secret', title: '保密交付', files: [file] }],
      evidence,
      verifyResults: { ok: true },
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    assert.equal(pack.summary.evidence.entryCount, 1)
    const manifestText = readFileSync(join(outDir, 'manifest.json'), 'utf8')
    const readme = readFileSync(join(outDir, 'README.txt'), 'utf8')
    for (const text of [manifestText, readme]) {
      assert.equal(text.includes(secretBody), false)
      assert.equal(text.includes(longQuote), false)
      assert.equal(text.includes('张'.repeat(501)), false)
    }
    const source = JSON.parse(manifestText).evidence.entries[0].sources[0]
    assert.equal(Array.from(source.quote).length, 500)
    assert.equal(source.quoteChars, 700)
    assert.equal(source.truncated, true)
    assert.equal(source.quoteSha256, sha256Hex(source.quote))
    assert.equal(verifyReceiptPackDir(outDir).ok, true)
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// evidence pack O(N²) fix + default cap (performance audit P0-3)
// ---------------------------------------------------------------------------

function syntheticLedger(count) {
  const facts = new Array(count)
  for (let index = 0; index < count; index += 1) facts[index] = { id: 'fact_bench_' + index }
  return Ledger.fromJSON({
    version: 1,
    matters: [],
    facts,
    commitments: [],
    preferences: [],
    links: [],
    updates: [],
    routes: {},
    routines: [],
    routinePatches: [],
  })
}

test('evidence pack default path is capped; all:true opts into the full pack', () => {
  assert.equal(DEFAULT_MAX_EVIDENCE_ENTRIES, 2000)
  const ledger = syntheticLedger(3)
  assert.throws(
    () => buildEvidencePack({ store: {}, ledger, ids: ['fact_0', 'fact_1', 'fact_2'], limit: 2 }),
    (error) => {
      assert.ok(error instanceof EvidencePackLimitError)
      assert.equal(error.code, 'EVIDENCE_PACK_TOO_LARGE')
      assert.equal(error.count, 3)
      assert.equal(error.limit, 2)
      assert.match(error.message, /--ids/)
      assert.match(error.message, /--all/)
      return true
    },
  )
  const tooMany = syntheticLedger(1)
  assert.throws(
    () =>
      buildEvidencePack({
        store: {},
        ledger: tooMany,
        ids: Array.from({ length: 2001 }, (_, index) => 'fact_' + index),
      }),
    /limit 2000/,
  )
  const full = buildEvidencePack({ store: {}, ledger, ids: ['fact_0', 'fact_1', 'fact_2'], all: true, now: FIXED_NOW })
  assert.equal(full.summary.entryCount, 3)
  assert.equal(verifyPack(full.files).ok, true)
})

test('80k synthetic evidence pack stays linear and under 2s', () => {
  const count = 80_000
  const ledger = syntheticLedger(count)
  const ids = new Array(count)
  for (let index = 0; index < count; index += 1) ids[index] = 'fact_bench_' + index
  const started = process.hrtime.bigint()
  const pack = buildEvidencePack({ store: {}, ledger, ids, all: true, now: FIXED_NOW })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(pack.summary.entryCount, count)
  const manifest = JSON.parse(pack.files['manifest.json'])
  assert.equal(manifest.entryCount, count)
  assert.ok(pack.files['manifest.json'].length < 15 * 1024 * 1024, 'manifest must stay linear')
  assert.ok(elapsedMs < 2000, '80k-entry pack took ' + elapsedMs.toFixed(1) + 'ms, expected < 2000ms')
})

