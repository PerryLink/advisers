import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { buildReceiptPack, sha256Hex } from '../lib/evidence.js'
import { verifyReceiptPackDir } from '../lib/receipt-verify.js'

// Security audit 2026-11-17 SEC2-05: manifest.anchors were only shape-checked
// (file exists, digest matches SHA256SUMS, adapterId/proof non-empty), yet the
// verifier result presented that as "anchored". A forged
// {adapterId:'rfc3161-tsa', proof:'TOTALLY-FAKE-PROOF'} passed. The verifier
// must now report the anchors as recorded-but-unverified and never as anchored.

const FIXED_NOW = '2026-11-17T04:00:00.000Z'
const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function makeWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-anchor-' + name + '-'))
  const work = join(root, 'work')
  mkdirSync(work)
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeArtifact(work, name, content) {
  const file = join(work, name)
  writeFileSync(file, content)
  return file
}

function cli(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: tosEnv(home, {
      ...process.env,
      ADVISERS_HOME: home,
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_NO_MODEL: '1',
      ADVISERS_STORE: 'sqlite',
    }),
  })
}

test('a recorded anchor with a forged proof is reported unverified, never anchored', async () => {
  const ws = makeWorkspace('forged')
  try {
    const file = writeArtifact(ws.work, 'quote.docx', Buffer.from('anchored artifact bytes'))
    const sha = sha256Hex(readFileSync(file))
    const forgedAnchor = {
      file: 'deliveries/del_fake/quote.docx',
      fileSha256: sha,
      adapterId: 'rfc3161-tsa',
      issuedAt: '2026-11-17T03:30:00.000Z',
      proof: 'TOTALLY-FAKE-PROOF',
    }
    const outDir = join(ws.root, 'forged-pack')
    const pack = await buildReceiptPack({
      deliveries: [{ id: 'del_fake', files: [file] }],
      verifyResults: { ok: true },
      anchors: [forgedAnchor],
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    // The builder records what it was given; it does not verify adapters.
    assert.equal(pack.summary.anchored, true)

    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
    assert.equal(verified.anchorsRecorded, 1)
    assert.equal(verified.anchorsVerified, false, 'this tool cannot verify anchor proofs')
    assert.equal(verified.anchored, false, 'a recorded-but-unverified anchor must not be reported as anchored')
    assert.ok(
      verified.warnings.some((warning) => /anchors are recorded but NOT cryptographically verified/.test(warning)),
      'the result must warn that the proof was not verified',
    )
    assert.doesNotMatch(JSON.stringify({ ...verified, manifest: null }), /"anchored":\s*true/)

    // The CLI prints the verifier JSON (bin is untouched by this fix); the
    // machine-readable "not verified" markers and the warning must be visible.
    const home = join(ws.root, 'home')
    mkdirSync(home, { recursive: true })
    const cliOutput = JSON.parse(cli(home, ['evidence', 'verify', outDir], ws.work))
    assert.equal(cliOutput.ok, true)
    assert.equal(cliOutput.anchorsRecorded, 1)
    assert.equal(cliOutput.anchorsVerified, false)
    assert.equal(cliOutput.anchored, false)
    assert.ok(cliOutput.warnings.some((warning) => /NOT cryptographically verified/.test(warning)))
  } finally {
    ws.cleanup()
  }
})

test('a pack without anchors keeps the existing not-anchored warning and flags', async () => {
  const ws = makeWorkspace('plain')
  try {
    const file = writeArtifact(ws.work, 'quote.docx', Buffer.from('plain artifact bytes'))
    const outDir = join(ws.root, 'plain-pack')
    await buildReceiptPack({
      deliveries: [{ id: 'del_plain', files: [file] }],
      verifyResults: { ok: true },
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true)
    assert.equal(verified.anchorsRecorded, 0)
    assert.equal(verified.anchorsVerified, false)
    assert.equal(verified.anchored, false)
    assert.ok(verified.warnings.some((warning) => /not externally anchored/.test(warning)))
  } finally {
    ws.cleanup()
  }
})
