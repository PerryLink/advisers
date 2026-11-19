/**
 * Anti-false-green gate test for scripts/check-tos.mjs.
 *
 * docs/TOS.md §9.3 and docs/PRIVACY.md §4 must disclose every egress surface the
 * `privacy` command prints. This test proves the gate actually fails when the
 * bridge/Hermes row is deleted, the TOS bridge clause is deleted, or a new
 * `privacy` egress surface is added without a matching legal row — a gate that
 * only greps for the word "bridge" somewhere in the document would stay green
 * after those deletions because the word survives elsewhere.
 *
 * check-tos.mjs derives its root from its own file location, so the mutations
 * run against a throwaway copy of the working tree (node_modules/.git skipped).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const SKIP_PARTS = new Set(['.git', 'node_modules'])

function runCheck(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-tos.mjs'), '--release'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
  })
}

function copyWorkingTree(target) {
  cpSync(repoRoot, target, {
    recursive: true,
    filter: (src) => !relative(repoRoot, src).split(sep).some((part) => SKIP_PARTS.has(part)),
  })
}

function readTree(root) {
  return {
    privacy: readFileSync(join(root, 'docs', 'PRIVACY.md'), 'utf8'),
    tos: readFileSync(join(root, 'docs', 'TOS.md'), 'utf8'),
    bin: readFileSync(join(root, 'packages', 'advisers', 'bin', 'advisers.js'), 'utf8'),
  }
}

test('check-tos: release gate passes and runs the bridge egress mapping checks', () => {
  const result = runCheck(repoRoot)
  assert.equal(result.status, 0, 'check-tos --release must pass\n' + result.stdout + result.stderr)
  assert.match(result.stdout, /PASS TOS consistency \(release mode, v\d{4}\.\d{2}\.\d+/)
  assert.match(result.stdout, /PASS privacy egress surface is mapped to a legal disclosure: bridge/)
  assert.match(result.stdout, /PASS docs\/PRIVACY\.md §4 has a bridge\/Hermes table row/)
  assert.match(result.stdout, /PASS docs\/TOS\.md §9\.3 has a bridge \(h\) clause/)
})

test('check-tos: missing bridge disclosure or unmapped egress surface FAILS', { timeout: 240000 }, () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'advisers-check-tos-'))
  const shadow = join(tempRoot, 'repo')
  try {
    copyWorkingTree(shadow)
    const original = readTree(shadow)
    const baseline = runCheck(shadow)
    assert.equal(baseline.status, 0, 'baseline shadow tree must pass\n' + baseline.stdout + baseline.stderr)

    // 1. Delete the PRIVACY §4 bridge row. The word "bridge" survives elsewhere
    //    (§1, §5.1, §8.1), so a document-wide grep gate would stay green.
    const privacyPath = join(shadow, 'docs', 'PRIVACY.md')
    writeFileSync(privacyPath, original.privacy.split(/\r?\n/).filter((line) => !/^\|\s*\d+\s*\|[^\n]*bridge/i.test(line)).join('\n') + '\n')
    const noPrivacyRow = runCheck(shadow)
    assert.equal(noPrivacyRow.status, 1, 'deleting the PRIVACY bridge row must FAIL\n' + noPrivacyRow.stdout)
    assert.match(noPrivacyRow.stdout, /FAIL docs\/PRIVACY\.md §4 has a bridge\/Hermes table row/)
    writeFileSync(privacyPath, original.privacy)

    // 2. Delete the TOS §9.3(h) bridge clause. "bridge"/"Hermes" survive in
    //    §2.2/§9.4/§9.6, so REQUIRED_EGRESS alone would stay green.
    const tosPath = join(shadow, 'docs', 'TOS.md')
    writeFileSync(tosPath, original.tos.split(/\r?\n/).filter((line) => !/^（h）[^\n]*bridge/i.test(line)).join('\n') + '\n')
    const noTosClause = runCheck(shadow)
    assert.equal(noTosClause.status, 1, 'deleting the TOS bridge clause must FAIL\n' + noTosClause.stdout)
    assert.match(noTosClause.stdout, /FAIL docs\/TOS\.md §9\.3 has a bridge \(h\) clause/)
    writeFileSync(tosPath, original.tos)

    // 3. Add a new `privacy` egress surface with no legal disclosure row.
    const binPath = join(shadow, 'packages', 'advisers', 'bin', 'advisers.js')
    const marker = "    'bridge — Hermes file gateway: inbox/outbox JSON files are handed to the Hermes process',"
    assert.ok(original.bin.includes(marker), 'cannot find the bridge egress line in bin/advisers.js')
    writeFileSync(binPath, original.bin.replace(marker, marker + "\n    'telepathy — unmapped surface: must be disclosed before release',"))
    const unmapped = runCheck(shadow)
    assert.equal(unmapped.status, 1, 'a privacy egress surface without a legal row must FAIL\n' + unmapped.stdout)
    assert.match(unmapped.stdout, /FAIL privacy egress surface is mapped to a legal disclosure: telepathy/)
    writeFileSync(binPath, original.bin)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
