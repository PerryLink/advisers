import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RECEIPT_MANIFEST_FORMAT,
  RECEIPT_MANIFEST_VERSION,
  RECEIPT_MANIFEST_VERSIONS,
  RECEIPT_REQUIRED_FILES,
  RECEIPT_SCOPES,
  RECEIPT_SUBJECT_KINDS,
  buildReceiptPack,
  sha256Hex,
} from '../lib/evidence.js'
import { parseReceiptSums, verifyReceiptPackDir } from '../lib/receipt-verify.js'

// 0.3.2 delivery receipt pack manifest v2 (subject / scope / row lineage).
// Contract:
//  - buildReceiptPack writes version 2, always a scope, and a subject only when
//    the caller supplies one; row-level clientId/projectId/matterId/template
//    are written only when present (v1 row shape stays byte-clean otherwise).
//  - lib/receipt-verify.js accepts manifest version 1 or 2; v1 validation is
//    unchanged (static v1 fixture below), v2 adds the subject/scope/lineage
//    checks, and an unknown version is still an error.
//  - README.txt and receipt.docx both print the scope warning (zh + en).

const FIXED_NOW = '2026-11-17T04:00:00.000Z'
const QUOTE_BYTES = Buffer.from('quote delivery bytes for manifest v2')
const DATA_SHA = sha256Hex('quote template data')
const SUBJECT_ZH = '本包只含 client 王工 (cl_wang) 的数据，全局 facts/preferences 默认不含。'
const SUBJECT_EN = 'This pack contains only the data of client 王工 (cl_wang); global facts/preferences are not included by default.'
const LOCAL_ALL_ZH = '本包含本机全部客户数据，勿直接发给第三方。'
const LOCAL_ALL_EN = 'This pack contains all customer data on this machine; do not send it directly to a third party.'

function makeWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-v2-' + name + '-'))
  const work = join(root, 'work')
  mkdirSync(work)
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeArtifact(work, name, content) {
  const file = join(work, name)
  writeFileSync(file, content)
  return file
}

function deliveryWithLineage(file) {
  return {
    id: 'del_wang',
    title: '报价确认单',
    tool: 'template:quote',
    createdAt: '2026-11-17T03:00:00.000Z',
    validation: 'docx',
    files: [file],
    clientId: 'cl_wang',
    projectId: 'prj_site',
    matterId: 'matter_x',
    templateName: 'quote',
    templateVersion: '1',
    quoteNo: 'Q-2026-001',
    // Builder lowercases dataSha256 before writing it.
    dataSha256: DATA_SHA.toUpperCase(),
  }
}

function baseEnv() {
  return {
    advisersVersion: '0.3.2-test',
    nodeVersion: 'v-test',
    templateName: 'quote',
    templateVersion: '1',
    command: 'advisers deliveries --receipt --subject client:cl_wang',
  }
}

/** Build a subject-scoped v2 pack with full row lineage. */
async function buildSubjectPack(ws, name, overrides = {}) {
  const artifact = writeArtifact(ws.work, 'quote.docx', QUOTE_BYTES)
  const outDir = join(ws.root, name)
  const pack = await buildReceiptPack({
    deliveries: [deliveryWithLineage(artifact)],
    subject: { kind: 'client', id: 'cl_wang', name: '王工' },
    evidence: {
      summary: {
        format: 'advisers-evidence-pack',
        version: 1,
        entries: [
          {
            kind: 'commitment',
            id: 'cm_v2',
            found: true,
            sources: [
              { sessionId: 'conv-1', turnId: 'turn_1', quote: '周五前把报价发给王工', quoteChars: 10, truncated: false, quoteSha256: sha256Hex('周五前把报价发给王工') },
            ],
            missing: [],
          },
        ],
      },
    },
    verifyResults: { ok: true },
    env: baseEnv(),
    now: FIXED_NOW,
    outDir,
    docxBuilder: false,
    ...overrides,
  })
  return { pack, outDir, artifact }
}

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

function copyPack(src, suffix) {
  const dest = src + '-' + suffix
  cpSync(src, dest, { recursive: true })
  return dest
}

function receiptDocxText(outDir) {
  // The deterministic fallback DOCX stores word/document.xml uncompressed, so
  // the UTF-8 paragraph text is greppable in the raw bytes.
  return readFileSync(join(outDir, 'receipt.docx'))
}

function assertDocxContains(outDir, text) {
  assert.ok(
    receiptDocxText(outDir).includes(Buffer.from(text, 'utf8')),
    'receipt.docx must contain: ' + text,
  )
}

// ---------------------------------------------------------------------------
// v2 shape: subject pack
// ---------------------------------------------------------------------------

test('v2 subject pack records subject/scope/lineage and verifies offline', async () => {
  const ws = makeWorkspace('subject')
  try {
    const { pack, outDir } = await buildSubjectPack(ws, 'pack')
    assert.equal(RECEIPT_MANIFEST_VERSION, 2)
    assert.deepEqual(RECEIPT_MANIFEST_VERSIONS, [1, 2])
    assert.deepEqual(RECEIPT_SCOPES, ['subject', 'local-all'])
    assert.deepEqual(RECEIPT_SUBJECT_KINDS, ['client', 'project', 'matter', 'none'])

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.format, RECEIPT_MANIFEST_FORMAT)
    assert.equal(manifest.version, 2)
    assert.equal(manifest.scope, 'subject')
    assert.deepEqual(manifest.subject, { kind: 'client', id: 'cl_wang', name: '王工' })
    const delivery = manifest.deliveries[0]
    assert.equal(delivery.clientId, 'cl_wang')
    assert.equal(delivery.projectId, 'prj_site')
    assert.equal(delivery.matterId, 'matter_x')
    assert.deepEqual(delivery.template, {
      name: 'quote',
      version: '1',
      quoteNo: 'Q-2026-001',
      dataSha256: DATA_SHA,
    })

    // summary exposes the v2 fields; the CLI reads summary.version.
    assert.equal(pack.summary.version, 2)
    assert.deepEqual(pack.summary.subject, { kind: 'client', id: 'cl_wang', name: '王工' })
    assert.equal(pack.summary.scope, 'subject')
    assert.equal(pack.summary.deliveryCount, 1)
    assert.equal(pack.summary.fileCount, 4)

    // SHA256SUMS coverage is unchanged: every file except SHA256SUMS itself.
    const parsed = parseReceiptSums(readFileSync(join(outDir, 'SHA256SUMS'), 'utf8'))
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.entries.size, 4)
    for (const required of RECEIPT_REQUIRED_FILES) assert.ok(parsed.entries.has(required), required)
    for (const [name, digest] of parsed.entries) {
      assert.equal(digest, sha256Hex(readFileSync(join(outDir, ...name.split('/')))), name)
    }
    assert.equal(manifest.receipt.sha256, parsed.entries.get('receipt.docx'))

    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
    assert.deepEqual(verified.errors, [])
    assert.equal(verified.checksumCount, 4)
    assert.equal(verified.fileCount, 5)

    // README + receipt.docx both carry the subject-scope warning (zh + en).
    const readme = readFileSync(join(outDir, 'README.txt'), 'utf8')
    assert.ok(readme.includes(SUBJECT_ZH), 'README must contain the Chinese subject-scope line')
    assert.ok(readme.includes(SUBJECT_EN), 'README must contain the English subject-scope line')
    assert.match(readme, /^subject:     client 王工 \(cl_wang\)$/m)
    assert.match(readme, /^scope:       subject /m)
    assertDocxContains(outDir, SUBJECT_ZH)
    assertDocxContains(outDir, SUBJECT_EN)
    assert.equal(readme.includes(LOCAL_ALL_ZH), false, 'a subject pack must not print the local-all warning')
  } finally {
    ws.cleanup()
  }
})

test('v2 local-all pack (no subject) warns that it holds all customer data', async () => {
  const ws = makeWorkspace('local-all')
  try {
    const artifact = writeArtifact(ws.work, 'quote.docx', QUOTE_BYTES)
    const outDir = join(ws.root, 'pack')
    const pack = await buildReceiptPack({
      deliveries: [{ id: 'del_plain', title: '普通交付', files: [artifact] }],
      verifyResults: { ok: true },
      env: baseEnv(),
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    assert.equal(pack.summary.scope, 'local-all')
    assert.equal(pack.summary.subject, null)
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 2)
    assert.equal(manifest.scope, 'local-all')
    assert.equal('subject' in manifest, false, 'subject is written only when the caller passes one')
    // No lineage passed -> the v1 row shape is preserved exactly.
    assert.equal('clientId' in manifest.deliveries[0], false)
    assert.equal('template' in manifest.deliveries[0], false)

    const readme = readFileSync(join(outDir, 'README.txt'), 'utf8')
    assert.ok(readme.includes(LOCAL_ALL_ZH))
    assert.ok(readme.includes(LOCAL_ALL_EN))
    assert.equal(readme.includes(SUBJECT_ZH), false)
    assertDocxContains(outDir, LOCAL_ALL_ZH)
    assertDocxContains(outDir, LOCAL_ALL_EN)
    assert.equal(verifyReceiptPackDir(outDir).ok, true)
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// v1 static fixture: the old manifest shape keeps verifying (and is not
// retro-fitted with v2 requirements)
// ---------------------------------------------------------------------------

function writeV1Fixture(dir) {
  const artifactPath = 'deliveries/del_v1/report.txt'
  const artifactBytes = Buffer.from('static v1 fixture delivered bytes')
  const receiptBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')])
  const quote = 'static v1 fixture quote'
  const manifest = {
    format: RECEIPT_MANIFEST_FORMAT,
    version: 1,
    createdAt: FIXED_NOW,
    generator: {
      advisersVersion: '0.3.1',
      nodeVersion: 'v-test',
      platform: 'linux',
      templateName: null,
      templateVersion: null,
      command: 'advisers deliveries --receipt',
    },
    recipient: null,
    deliveries: [
      {
        id: 'del_v1',
        title: 'v1 交付',
        tool: 'deliver:old',
        createdAt: null,
        validation: null,
        files: [{ path: artifactPath, name: 'report.txt', size: artifactBytes.length, sha256: sha256Hex(artifactBytes) }],
      },
    ],
    receipt: { path: 'receipt.docx', size: receiptBytes.length, sha256: sha256Hex(receiptBytes) },
    verify: [{ source: 'advisers verify', ok: true, checkedAt: null, errors: [], checks: [], summary: null }],
    verifyStatus: 'passed',
    anchors: [],
    evidence: {
      format: 'advisers-evidence-pack',
      version: 1,
      entryCount: 1,
      counts: { commitment: 1, fact: 0, preference: 0, unknown: 0 },
      sourceCount: 1,
      missingCount: 0,
      entries: [
        {
          kind: 'commitment',
          id: 'cm_v1',
          found: true,
          sources: [{ sessionId: 'conv-1', turnId: 'turn_1', quote, quoteChars: Array.from(quote).length, truncated: false, quoteSha256: sha256Hex(quote) }],
          missing: [],
        },
      ],
    },
    fileCount: RECEIPT_REQUIRED_FILES.length + 1,
  }
  mkdirSync(join(dir, 'deliveries', 'del_v1'), { recursive: true })
  writeFileSync(join(dir, ...artifactPath.split('/')), artifactBytes)
  writeFileSync(join(dir, 'receipt.docx'), receiptBytes)
  const readme = 'Advisers delivery receipt pack\nformat: advisers-delivery-receipt-pack v1\n'
  writeFileSync(join(dir, 'README.txt'), readme)
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(join(dir, 'manifest.json'), manifestText)
  const sums = [
    sha256Hex(manifestText) + '  manifest.json',
    sha256Hex(readme) + '  README.txt',
    sha256Hex(receiptBytes) + '  receipt.docx',
    sha256Hex(artifactBytes) + '  ' + artifactPath,
  ]
  writeFileSync(join(dir, 'SHA256SUMS'), sums.join('\n') + '\n')
  return dir
}

test('a static v1 fixture with no subject/scope/lineage still verifies unchanged', () => {
  const ws = makeWorkspace('v1-fixture')
  try {
    const dir = writeV1Fixture(join(ws.root, 'v1-pack'))
    const result = verifyReceiptPackDir(dir)
    assert.equal(result.ok, true, result.errors.join(' | '))
    assert.deepEqual(result.errors, [])
    assert.equal(result.manifest.version, 1)
    assert.equal('scope' in result.manifest, false)
    assert.equal('subject' in result.manifest, false)
    assert.equal(result.checksumCount, 4)
    assert.equal(result.fileCount, 5)
    // Same v1-era warnings only; no new "scope is required" style error.
    assert.ok(result.warnings.some((warning) => /not externally anchored/.test(warning)))

    // "v1 validation is unchanged" also means v2-only keys are not retro-fitted:
    // the pre-v2 verifier ignored unknown fields, so a v1 stamp with junk
    // subject/scope keeps verifying. (The builder never writes that shape.)
    const lenient = copyPack(dir, 'v1-extra-keys')
    resealManifest(lenient, (manifest) => {
      manifest.scope = 'bogus'
      manifest.subject = { kind: 'bogus' }
    })
    const lenientResult = verifyReceiptPackDir(lenient)
    assert.equal(lenientResult.ok, true, lenientResult.errors.join(' | '))
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// v2 schema drift (checksums re-sealed so only the schema can fail)
// ---------------------------------------------------------------------------

test('v2 rejects invalid subject/scope/lineage even when checksums are recomputed', async () => {
  const ws = makeWorkspace('invalid')
  try {
    const { outDir: base } = await buildSubjectPack(ws, 'base')
    const cases = [
      ['version-3', (manifest) => { manifest.version = 3 }, 'manifest.version'],
      ['scope-missing', (manifest) => { delete manifest.scope }, 'manifest.scope'],
      ['scope-bogus', (manifest) => { manifest.scope = 'everything' }, 'manifest.scope'],
      ['subject-kind', (manifest) => { manifest.subject.kind = 'company' }, 'manifest.subject.kind'],
      ['subject-no-id-name', (manifest) => { delete manifest.subject.id; delete manifest.subject.name }, 'requires at least one of id/name'],
      ['subject-none-with-id', (manifest) => { manifest.subject = { kind: 'none', id: 'cl_wang' } }, "must not carry id/name when kind is 'none'"],
      ['subject-name-type', (manifest) => { manifest.subject.name = 42 }, 'manifest.subject.name must be a non-empty string'],
      ['subject-not-object', (manifest) => { manifest.subject = 'client:cl_wang' }, 'manifest.subject must be an object'],
      ['row-client-id', (manifest) => { manifest.deliveries[0].clientId = '' }, 'clientId must be a non-empty string'],
      ['row-matter-id', (manifest) => { manifest.deliveries[0].matterId = 42 }, 'matterId must be a non-empty string'],
      ['template-not-object', (manifest) => { manifest.deliveries[0].template = 'quote' }, '.template must be an object'],
      ['template-version-missing', (manifest) => { delete manifest.deliveries[0].template.version }, '.template.version must be a non-empty string'],
      ['template-data-sha', (manifest) => { manifest.deliveries[0].template.dataSha256 = 'not-a-sha' }, '.template.dataSha256 must be 64 lowercase hex characters'],
      ['template-data-sha-upper', (manifest) => { manifest.deliveries[0].template.dataSha256 = DATA_SHA.toUpperCase() }, '.template.dataSha256 must be 64 lowercase hex characters'],
    ]
    for (const [suffix, mutate, needle] of cases) {
      const dir = copyPack(base, suffix)
      resealManifest(dir, mutate)
      const result = expectVerifyFailure(dir, needle)
      assert.ok(result.errors.some((error) => error.includes(needle)), suffix + ': ' + result.errors.join(' | '))
    }

    // Upgrading the v1 fixture's version stamp without the v2 scope is drift too.
    const v1 = writeV1Fixture(join(ws.root, 'v1-upgraded'))
    resealManifest(v1, (manifest) => { manifest.version = 2 })
    expectVerifyFailure(v1, 'manifest.scope is required for manifest version 2')
  } finally {
    ws.cleanup()
  }
})

test('a v2 pack may carry a client/project/matter template lineage without a subject (local-all)', async () => {
  const ws = makeWorkspace('lineage-local')
  try {
    const artifact = writeArtifact(ws.work, 'quote.docx', QUOTE_BYTES)
    const outDir = join(ws.root, 'pack')
    await buildReceiptPack({
      deliveries: [deliveryWithLineage(artifact)],
      verifyResults: { ok: true },
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.scope, 'local-all')
    assert.equal(manifest.deliveries[0].clientId, 'cl_wang')
    assert.equal(manifest.deliveries[0].template.name, 'quote')
    const result = verifyReceiptPackDir(outDir)
    assert.equal(result.ok, true, result.errors.join(' | '))
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// builder input validation (fail closed, never write a lying pack)
// ---------------------------------------------------------------------------

function inlineDelivery(extra = {}) {
  return { id: 'del_inline', files: [{ content: 'inline bytes', name: 'note.txt' }], ...extra }
}

async function rejects(options, pattern) {
  await assert.rejects(
    buildReceiptPack({ deliveries: [inlineDelivery()], now: FIXED_NOW, docxBuilder: false, ...options }),
    pattern,
  )
}

test('buildReceiptPack rejects invalid subject/scope/lineage inputs', async () => {
  await rejects({ subject: { kind: 'company', id: 'x' } }, /subject\.kind must be one of/)
  await rejects({ subject: { kind: 'client' } }, /requires subject\.id or subject\.name/)
  await rejects({ subject: { kind: 'none', id: 'cl_wang' } }, /'none' must not carry id or name/)
  await rejects({ subject: { kind: 'client', id: 42 } }, /subject\.id must be a non-empty string/)
  await rejects({ subject: 'client:cl_wang' }, /subject must be an object/)
  await rejects({ scope: 'everything' }, /scope must be 'subject' or 'local-all'/)
  await rejects({ scope: 'subject' }, /scope 'subject' requires a subject/)
  await rejects({ subject: { kind: 'client', id: 'cl_wang' }, scope: 'local-all' }, /scope 'local-all' cannot carry a subject/)
  await rejects({ deliveries: [inlineDelivery({ clientId: 42 })] }, /clientId must be a non-empty string/)
  await rejects({ deliveries: [inlineDelivery({ matterId: '   ' })] }, /matterId must be a non-empty string/)
  await rejects({ deliveries: [inlineDelivery({ templateName: 'quote' })] }, /requires both templateName and templateVersion/)
  await rejects(
    { deliveries: [inlineDelivery({ templateName: 'quote', templateVersion: '1', dataSha256: 'xyz' })] },
    /dataSha256 must be 64 lowercase hex characters/,
  )
})

test('builder defaults scope from the subject and honours an explicit scope', async () => {
  const plain = await buildReceiptPack({ deliveries: [inlineDelivery()], now: FIXED_NOW, docxBuilder: false })
  assert.equal(plain.summary.scope, 'local-all')
  assert.equal(plain.summary.subject, null)
  const manifest = JSON.parse(plain.files['manifest.json'])
  assert.equal(manifest.version, 2)
  assert.equal(manifest.scope, 'local-all')
  assert.equal('subject' in manifest, false)

  const subjectPack = await buildReceiptPack({
    deliveries: [inlineDelivery()],
    subject: { kind: 'project', id: 'prj_site' },
    now: FIXED_NOW,
    docxBuilder: false,
  })
  assert.equal(subjectPack.summary.scope, 'subject')
  assert.deepEqual(subjectPack.summary.subject, { kind: 'project', id: 'prj_site' })

  // {kind:'none'} declares "no single subject" and is local-all by default.
  const nonePack = await buildReceiptPack({
    deliveries: [inlineDelivery()],
    subject: { kind: 'none' },
    now: FIXED_NOW,
    docxBuilder: false,
  })
  assert.equal(nonePack.summary.scope, 'local-all')
  assert.equal(JSON.parse(nonePack.files['manifest.json']).subject.kind, 'none')
})

// ---------------------------------------------------------------------------
// determinism: same clock + inputs -> identical manifest / README / receipt
// ---------------------------------------------------------------------------

test('v2 pack bytes are deterministic for the same now and inputs', async () => {
  const ws = makeWorkspace('deterministic')
  try {
    const artifact = writeArtifact(ws.work, 'quote.docx', QUOTE_BYTES)
    const build = (name) =>
      buildReceiptPack({
        deliveries: [deliveryWithLineage(artifact)],
        subject: { kind: 'client', id: 'cl_wang', name: '王工' },
        verifyResults: { ok: true },
        env: baseEnv(),
        now: FIXED_NOW,
        outDir: join(ws.root, name),
        docxBuilder: false,
      })
    const first = await build('one')
    const second = await build('two')
    for (const name of ['manifest.json', 'README.txt', 'SHA256SUMS', 'receipt.docx']) {
      const left = readFileSync(join(ws.root, 'one', name))
      const right = readFileSync(join(ws.root, 'two', name))
      assert.deepEqual(left, right, name + ' must be byte-identical for identical inputs')
    }
    assert.equal(first.summary.manifestDigest, second.summary.manifestDigest)
    assert.equal(first.summary.receiptSha256, second.summary.receiptSha256)
  } finally {
    ws.cleanup()
  }
})
