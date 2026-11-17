import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Release audit P1-5: engines say Node >= 22.16 (node:sqlite has FTS5 from that
// version) but the CLI banner/help and doctor still advertised 22.13.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

function env(home) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' })
}

test('bin runtime/help advertise Node >= 22.16, matching engines', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-node-floor-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    assert.equal(packageJson.engines.node, '>=22.16')
    const help = spawnSync(process.execPath, [bin, 'help'], { env: env(home), encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Node >= 22\.16/)
    assert.doesNotMatch(help.stdout, /22\.13/)
    const source = readFileSync(bin, 'utf8')
    assert.doesNotMatch(source, /22\.13/, 'no runtime banner may still advertise the old Node floor')
    assert.match(source, /Advisers needs Node >= 22\.16/)
    const doctor = spawnSync(process.execPath, [bin, 'doctor'], { env: env(home), encoding: 'utf8' })
    assert.match(doctor.stdout, /PASS  node/)
    assert.doesNotMatch(doctor.stdout, /FAIL  node/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
