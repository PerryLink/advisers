import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CONTEXT_PACK_FILE_MODE,
  CONTEXT_PACK_DIR_MODE,
  CONTEXT_PACK_FORMAT,
  CONTEXT_PACK_ITEM_VERIFICATION_BASIS,
  CONTEXT_PACK_LIMIT_CODE,
  CONTEXT_PACK_MANIFEST_VERSION,
  CONTEXT_PACK_SHA256SUMS_FILE,
  CONTEXT_PACK_VERIFICATION_BASIS,
  assertContextPackNotImportable,
  buildContextPack,
  isContextPackDir,
  parseContextPackSums,
  readContextPackManifestHeader,
  verifyContextPackDir,
  writeContextPackDir,
} from '../lib/context-pack.js'
import { assertPrivateMode, symlinkOrSkip } from './win-compat.mjs'

// Context pack v1 (0.5.0 / 050-C1): builder, atomic write, offline verifier,
// hard caps, payload whitelist, disclosure invariants, tamper/extra/symlink
// refusal and the no-import guard. Pure fixtures only (temporary directories);
// the verifier never opens a ledger or HOME.

const GENERATED_AT = '2026-11-22T00:00:00.000Z'
const EXPIRES_AT = '2026-11-23T00:00:00.000Z'
const README_TEXT = 'Advisers context pack\nSHA256SUMS\nno import path: a pack cannot be re-ingested\nnot a signature, not a trusted timestamp\n'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-context-pack-'))
  process.env.ADVISERS_HOME = root
  return { root, out: join(root, 'pack') }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function itemOf(kind, payload, extra = {}) {
  return {
    id: extra.id ?? kind + '_1',
    kind,
    view: extra.view ?? 'pending',
    verification: extra.verification ?? { basis: CONTEXT_PACK_ITEM_VERIFICATION_BASIS, resolved: 0, missing: 0, unverifiable: 0, notChecked: 0 },
    payload,
  }
}

function commitmentItem(extra = {}) {
  return itemOf('commitment', { action: '发报价单', debtor: 'user', creditor: 'third:wang', status: 'open', matterId: 'm_web' }, { id: 'cm_quote', ...extra })
}

function buildPack(overrides = {}) {
  return buildContextPack({
    subject: { kind: 'client', id: 'cl_wang', name: '王工' },
    items: [commitmentItem()],
    recipient: 'Claude Code',
    purpose: 'external-review',
    expiresAt: EXPIRES_AT,
    generatedAt: GENERATED_AT,
    autoAssembled: true,
    candidateCount: 2,
    excluded: { secrecy: 0, stale: 0, unsupportedKind: 0, notFound: 0 },
    ...overrides,
  })
}

function writePack(dir, built) {
  return writeContextPackDir(dir, built)
}

/** Write a pack directory without the builder (negative fixtures). */
function writeRawPack(dir, { manifest, readme = README_TEXT, extra = {}, sums = 'auto' }) {
  mkdirSync(dir, { recursive: true })
  const manifestText = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(join(dir, 'manifest.json'), manifestText)
  writeFileSync(join(dir, 'README.txt'), readme)
  if (sums !== null) {
    const lines = [
      sha256(readFileSync(join(dir, 'manifest.json'))) + '  manifest.json',
      sha256(readFileSync(join(dir, 'README.txt'))) + '  README.txt',
    ]
    writeFileSync(join(dir, CONTEXT_PACK_SHA256SUMS_FILE), lines.join('\n') + '\n')
  }
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content)
}

/** Recompute SHA256SUMS after mutating a file (still-tampered fixtures). */
function refreshSums(dir) {
  const names = readdirSync(dir).filter((name) => name !== CONTEXT_PACK_SHA256SUMS_FILE).sort()
  const lines = names.map((name) => sha256(readFileSync(join(dir, name))) + '  ' + name)
  writeFileSync(join(dir, CONTEXT_PACK_SHA256SUMS_FILE), lines.join('\n') + '\n')
}

function mutateManifest(dir, mutate) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  mutate(manifest)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  refreshSums(dir)
}

test('buildContextPack returns the contracted three files and manifest v1 shape', () => {
  const built = buildPack({ candidateCount: 3, excluded: { secrecy: 1, stale: 2, unsupportedKind: 0, notFound: 0 } })
  assert.deepEqual([...built.files.keys()].sort(), ['README.txt', CONTEXT_PACK_SHA256SUMS_FILE, 'manifest.json'])
  const manifest = built.manifest
  assert.equal(manifest.format, CONTEXT_PACK_FORMAT)
  assert.equal(manifest.version, CONTEXT_PACK_MANIFEST_VERSION)
  assert.equal(manifest.verificationBasis, CONTEXT_PACK_VERIFICATION_BASIS)
  assert.equal(manifest.fileCount, 3)
  assert.deepEqual(manifest.subject, { kind: 'client', id: 'cl_wang', name: '王工' })
  assert.deepEqual(manifest.recipient, { name: 'Claude Code' })
  assert.equal(manifest.purpose, 'external-review')
  assert.equal(manifest.disclosure.autoAssembled, true)
  assert.equal(manifest.disclosure.candidateCount, 3)
  assert.equal(manifest.disclosure.selectedCount, 1)
  assert.equal(manifest.disclosure.itemCount, 1)
  assert.equal(manifest.disclosure.includesQuotes, false)
  assert.equal(manifest.disclosure.includesOriginalSources, false)
  assert.equal(manifest.disclosure.confersReadAuthority, false)
  assert.equal(manifest.disclosure.confersExecutionAuthority, false)
  assert.deepEqual(manifest.disclosure.excluded, { total: 3, byReason: { secrecy: 1, stale: 2, unsupportedKind: 0, notFound: 0 } })
  const item = manifest.items[0]
  assert.deepEqual(item.fields, Object.keys(item.payload).sort())
  assert.match(item.sha256, /^[0-9a-f]{64}$/)
  assert.equal(item.verification.basis, CONTEXT_PACK_ITEM_VERIFICATION_BASIS)
  assert.equal(built.manifestDigest, sha256(built.manifestText))
  assert.equal(built.files.get('manifest.json').toString('utf8'), built.manifestText)
})

test('two builds with the same inputs and clock are byte-identical', () => {
  const first = buildPack()
  const second = buildPack()
  for (const name of first.files.keys()) {
    assert.deepEqual(first.files.get(name), second.files.get(name), name + ' must be deterministic')
  }
})

test('write + verify round-trip, private modes and manifest digest check', () => {
  const { root, out } = setup()
  try {
    const built = buildPack()
    writePack(out, built)
    assertPrivateMode(out, CONTEXT_PACK_DIR_MODE, 'pack directory')
    for (const name of ['manifest.json', 'README.txt', CONTEXT_PACK_SHA256SUMS_FILE]) {
      assertPrivateMode(join(out, name), CONTEXT_PACK_FILE_MODE, name)
    }
    const verified = verifyContextPackDir(out)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
    assert.equal(verified.format, CONTEXT_PACK_FORMAT)
    assert.equal(verified.version, CONTEXT_PACK_MANIFEST_VERSION)
    assert.equal(verified.verificationBasis, CONTEXT_PACK_VERIFICATION_BASIS)
    assert.equal(verified.fileCount, 3)
    assert.equal(verified.checksumCount, 2)
    assert.equal(verified.manifestDigest, built.manifestDigest)
    const matched = verifyContextPackDir(out, { expectManifestSha256: built.manifestDigest })
    assert.equal(matched.ok, true)
    assert.equal(matched.matchesExpected, true)
    const mismatched = verifyContextPackDir(out, { expectManifestSha256: '0'.repeat(64) })
    assert.equal(mismatched.ok, false)
    assert.equal(mismatched.matchesExpected, false)
    assert.equal(mismatched.code, 'E_CONTEXT_PACK_DIGEST_MISMATCH')
    assert.equal(verifyContextPackDir(out, { expectManifestSha256: 'not-hex' }).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('write refuses a non-empty target and --force moves the old tree aside', () => {
  const { root, out } = setup()
  try {
    writePack(out, buildPack())
    assert.throws(() => writePack(out, buildPack()), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
    const written = writeContextPackDir(out, buildPack(), { overwrite: true })
    assert.ok(written.replaced && existsSync(written.replaced))
    assert.equal(verifyContextPackDir(out).ok, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('tamper, missing file, extra file and symlink are all rejected offline', (t) => {
  const { root, out } = setup()
  try {
    writeContextPackDir(out, buildPack(), { overwrite: true })
    const original = readFileSync(join(out, 'manifest.json'))
    const originalReadme = readFileSync(join(out, 'README.txt'))
    writeFileSync(join(out, 'manifest.json'), Buffer.concat([original, Buffer.from(' ')]))
    const tampered = verifyContextPackDir(out)
    assert.equal(tampered.ok, false)
    assert.equal(tampered.errors.some((error) => error.includes('hash mismatch: manifest.json')), true)
    writeFileSync(join(out, 'manifest.json'), original)
    assert.equal(verifyContextPackDir(out).ok, true)
    rmSync(join(out, 'README.txt'))
    assert.equal(verifyContextPackDir(out).ok, false)
    writeFileSync(join(out, 'README.txt'), originalReadme)
    assert.equal(verifyContextPackDir(out).ok, true)
    writeFileSync(join(out, 'extra.txt'), 'unexpected')
    const extra = verifyContextPackDir(out)
    assert.equal(extra.ok, false)
    assert.equal(extra.errors.some((error) => error.includes('unexpected file')), true)
    rmSync(join(out, 'extra.txt'))
    symlinkOrSkip(t, join(out, 'README.txt'), join(out, 'link.txt'))
    const linked = verifyContextPackDir(out)
    assert.equal(linked.ok, false)
    assert.equal(linked.errors.some((error) => error.includes('symbolic links are not allowed')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('forbidden money/body/file keys fail the builder and the verifier', () => {
  assert.throws(
    () => buildPack({ items: [itemOf('fact', { subject: '报价', predicate: '金额', object: '80000', amountMinor: 8000000 })] }),
    (error) => error.code === 'E_CONTEXT_PACK_INVALID',
  )
  assert.throws(
    () => buildPack({ items: [itemOf('commitment', { action: '发报价单', body: '邮件正文' })] }),
    (error) => error.code === 'E_CONTEXT_PACK_INVALID',
  )
  const { root, out } = setup()
  try {
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => {
      manifest.items[0].payload.amountMinor = 100
      manifest.items[0].fields = Object.keys(manifest.items[0].payload).sort()
    })
    const verified = verifyContextPackDir(out)
    assert.equal(verified.ok, false)
    assert.equal(verified.errors.some((error) => error.includes('forbidden key')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('disclosure invariants are enforced (authority flags, quote flag, exclusion total)', () => {
  const { root, out } = setup()
  try {
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.disclosure.confersReadAuthority = true })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.disclosure.confersExecutionAuthority = true })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.disclosure.includesQuotes = true })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.disclosure.excluded.total = 99 })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.disclosure.itemCount = 2 })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.verificationBasis = 'signed' })
    assert.equal(verifyContextPackDir(out).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unknown top-level manifest keys only warn; unknown item/kind/payload keys fail', () => {
  const { root, out } = setup()
  try {
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.futureField = { note: 'forward compatible' } })
    const future = verifyContextPackDir(out)
    assert.equal(future.ok, true, future.errors.join(' | '))
    assert.equal(future.warnings.some((warning) => warning.includes('unknown top-level key')), true)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.items[0].futureItemKey = 1 })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.items[0].kind = 'mail' })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => {
      manifest.items[0].payload.secret = 'x'
      manifest.items[0].fields = Object.keys(manifest.items[0].payload).sort()
    })
    assert.equal(verifyContextPackDir(out).ok, false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    mutateManifest(out, (manifest) => { manifest.subject.kind = 'owner' })
    assert.equal(verifyContextPackDir(out).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('v1 caps: item count, single item size, items size and untrusted entry count', () => {
  const seventeen = Array.from({ length: 17 }, (_, index) => commitmentItem({ id: 'cm_' + index }))
  assert.throws(() => buildPack({ items: seventeen }), (error) => error.code === CONTEXT_PACK_LIMIT_CODE && /item count/.test(error.message))
  assert.throws(
    () => buildPack({ items: [itemOf('fact', { subject: '报价', predicate: '金额', object: 'x'.repeat(9 * 1024) })] }),
    (error) => error.code === CONTEXT_PACK_LIMIT_CODE && /single item size/.test(error.message),
  )
  const fat = Array.from({ length: 5 }, (_, index) => itemOf('fact', { subject: '报价', predicate: '金额', object: String(index) + 'x'.repeat(7000) }, { id: 'fact_' + index }))
  assert.throws(() => buildPack({ items: fat }), (error) => error.code === CONTEXT_PACK_LIMIT_CODE && /items size/.test(error.message))
  const { root } = setup()
  try {
    const many = join(root, 'many')
    mkdirSync(many, { recursive: true })
    for (let index = 0; index < 20; index += 1) writeFileSync(join(many, 'f' + index + '.txt'), 'x')
    const verified = verifyContextPackDir(many)
    assert.equal(verified.ok, false)
    assert.equal(verified.code, CONTEXT_PACK_LIMIT_CODE)
    assert.equal(verified.limitViolation.limit, 'maxEntries')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('quotes are bounded to 500 characters and covered by quoteSha256', () => {
  const quote = '报价 80000 元，周五前发报价单'
  const fact = itemOf('fact', { subject: '报价', predicate: '金额', object: '80000', quote, quoteSha256: sha256(quote) }, { id: 'fact_price' })
  const built = buildPack({ items: [fact] })
  assert.equal(built.manifest.disclosure.includesQuotes, true)
  const { root, out } = setup()
  try {
    writePack(out, built)
    assert.equal(verifyContextPackDir(out).ok, true)
    mutateManifest(out, (manifest) => { manifest.items[0].payload.quoteSha256 = 'a'.repeat(64) })
    assert.equal(verifyContextPackDir(out).ok, false)
    const huge = 'x'.repeat(501)
    assert.throws(
      () => buildPack({ items: [itemOf('fact', { subject: 's', predicate: 'p', object: 'o', quote: huge, quoteSha256: sha256(huge) })] }),
      (error) => error.code === 'E_CONTEXT_PACK_INVALID',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('builder rejects empty items and bad disclosure inputs', () => {
  assert.throws(() => buildPack({ items: [] }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => buildPack({ purpose: 'unspecified' }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => buildPack({ recipient: '' }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => buildPack({ candidateCount: 0 }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => buildPack({ excluded: { secrecy: 1, stale: 1, unsupportedKind: 0, notFound: 0, total: 1 } }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => buildPack({ excluded: { secrecy: 0, stale: 0, unsupportedKind: 0, notFound: 0, body: 1 } }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
})

test('manifest header dispatch and the no-import guard', () => {
  const { root, out } = setup()
  try {
    assert.deepEqual(readContextPackManifestHeader(join(root, 'missing')), { ok: false, format: null, version: null, error: 'directory not found' })
    assert.equal(isContextPackDir(join(root, 'missing')), false)
    writeContextPackDir(out, buildPack(), { overwrite: true })
    assert.deepEqual(readContextPackManifestHeader(out), { ok: true, format: CONTEXT_PACK_FORMAT, version: CONTEXT_PACK_MANIFEST_VERSION, error: null })
    assert.equal(isContextPackDir(out), true)
    assert.throws(() => assertContextPackNotImportable(out), (error) => error.code === 'E_CONTEXT_PACK_IMPORT_UNSUPPORTED')
    const plain = join(root, 'plain')
    mkdirSync(plain)
    assert.equal(isContextPackDir(plain), false)
    assert.equal(assertContextPackNotImportable(plain), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('parseContextPackSums rejects self-listing, duplicates, traversal and malformed lines', () => {
  const good = sha256('x') + '  manifest.json'
  assert.equal(parseContextPackSums(good + '\n').entries.size, 1)
  assert.equal(parseContextPackSums(good + '\n' + good + '\n').errors.length, 1)
  assert.equal(parseContextPackSums(sha256('x') + '  ' + CONTEXT_PACK_SHA256SUMS_FILE + '\n').errors.length, 1)
  assert.equal(parseContextPackSums(sha256('x') + '  ../evil\n').errors.length, 1)
  assert.equal(parseContextPackSums('not-a-line\n').errors.length, 1)
  assert.equal(parseContextPackSums(undefined).errors.length, 1)
})

test('the verifier never needs a ledger context (offline, no HOME access)', () => {
  const { root, out } = setup()
  try {
    writeContextPackDir(out, buildPack(), { overwrite: true })
    process.env.ADVISERS_HOME = join(root, 'does-not-exist')
    const verified = verifyContextPackDir(out)
    assert.equal(verified.ok, true)
    assert.equal(existsSync(join(root, 'does-not-exist')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
