/**
 * 0.3.0 Wave 3: `advisers evidence verify` must enforce the offline receipt
 * verifier's resource caps (lib/receipt-verify.js, 04-0.3-research §4.12):
 * a hostile pack exits 1 with the stable code E_RECEIPT_LIMIT, while stdout
 * stays exactly one JSON document (the code is also in the JSON payload).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, ftruncateSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isJsonPure } from '../lib/tui/json.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const MiB = 1024 * 1024

function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-receipt-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}
function cli(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }),
    encoding: 'utf8',
    input: '',
    timeout: 20000,
  })
}

test('0.3.0: evidence verify refuses an oversized pack with E_RECEIPT_LIMIT and exit 1', () => {
  const ws = workspace('limit')
  try {
    const pack = join(ws.root, 'hostile-pack')
    mkdirSync(pack)
    const huge = join(pack, 'huge.bin')
    writeFileSync(huge, '')
    const fd = openSync(huge, 'r+')
    try { ftruncateSync(fd, 33 * MiB) } finally { closeSync(fd) }
    const result = cli(ws.home, ['evidence', 'verify', pack])
    assert.equal(result.status, 1)
    assert.ok(isJsonPure(result.stdout), 'stdout must stay one pure JSON document')
    const data = JSON.parse(result.stdout)
    assert.equal(data.ok, false)
    assert.equal(data.code, 'E_RECEIPT_LIMIT')
    assert.equal(data.limitViolation.limit, 'maxFileBytes')
    assert.match(result.stderr, /E_RECEIPT_LIMIT/)
    assert.match(result.stderr, /maxFileBytes/)
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})

test('0.3.0: a missing pack directory is still reported as JSON with exit 1 (no limit code)', () => {
  const ws = workspace('missing')
  try {
    const result = cli(ws.home, ['evidence', 'verify', join(ws.root, 'does-not-exist')])
    assert.equal(result.status, 1)
    assert.ok(isJsonPure(result.stdout))
    const data = JSON.parse(result.stdout)
    assert.equal(data.ok, false)
    assert.equal(data.code, null)
    assert.ok(data.errors.some((line) => /not found/.test(line)), 'expected a not-found error: ' + JSON.stringify(data.errors))
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})
