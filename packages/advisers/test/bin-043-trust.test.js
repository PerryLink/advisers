/**
 * 0.4.3 (043-3, plans 90/91 §5.3 + §5.2 + profile): `doctor --report`, the
 * `privacy --prove --brief` four-line card and the read-only `profile` view.
 *
 * Core rule under test: an unmeasured dimension is explicit `null`, never
 * 0/false/PASS; `ok` only reflects the check table. profile is deterministic
 * (same rows -> same JSON/dataSha256) and writes 0600 files when asked.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertPrivateMode } from './win-compat.mjs'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1' }
const MEASURED_KEYS = [
  'modelQuality', 'semanticCorrectness', 'captureQuality', 'independentGoldStandard',
  'realMailAccount', 'win11RealMachine', 'windowsClientIme', 'officeAppFidelity', 'externalTimestamp',
]

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-trust-'))
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input: '', timeout: 60000,
  })
}

test('doctor --report --json is an explicit-null report, not fake PASS/0/false', () => {
  const home = makeHome()
  try {
    const result = run(home, ['doctor', '--report', '--json'])
    assert.ok(result.status === 0 || result.status === 1, 'report exits with the check-table result')
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, result.status === 0)
    assert.equal(report.mode, 'report')
    assert.equal(report.reportVersion, 1)
    assert.equal(typeof report.advisersVersion, 'string')
    assert.equal(report.schemaVersion, 23, 'SQLite schema v23 is reported')
    assert.deepEqual(Object.keys(report.measured), MEASURED_KEYS)
    for (const key of MEASURED_KEYS) {
      assert.equal(report.measured[key], null, key + ' is null (unknown, not false/0)')
      assert.equal(typeof report.nulls.find((entry) => entry.key === key)?.reason, 'string', key + ' has a reason')
    }
    assert.equal(report.nulls.length, MEASURED_KEYS.length)
    assert.ok(Array.isArray(report.notices))
    assert.ok(Array.isArray(report.limitations))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('doctor --report human output names null and its reasons', () => {
  const home = makeHome()
  try {
    const result = run(home, ['doctor', '--report'])
    assert.ok(result.status === 0 || result.status === 1)
    assert.match(result.stdout, /report v1\s+ok=/)
    assert.match(result.stdout, /modelQuality: null/)
    assert.match(result.stdout, /realMailAccount: null/)
    assert.match(result.stdout, /nulls:/)
    assert.match(result.stdout, /no independent human gold standard/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('doctor --report --repair is refused as E_USAGE', () => {
  const home = makeHome()
  try {
    const result = run(home, ['doctor', '--report', '--repair'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /E_USAGE/)
    assert.match(result.stderr, /--report cannot be combined with --repair/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('privacy --prove --brief prints exactly the four ordered lines', () => {
  const home = makeHome()
  try {
    const result = run(home, ['privacy', '--prove', '--brief'])
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stdout.trim().split('\n')
    assert.equal(lines.length, 4)
    assert.match(lines[0], /^at-rest\s/)
    assert.match(lines[1], /^sync\s/)
    assert.match(lines[2], /^export\s/)
    assert.match(lines[3], /^egress\s/)
    assert.match(lines[3], /默认不会出网/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('privacy --json --prove --brief returns the structured brief', () => {
  const home = makeHome()
  try {
    const result = run(home, ['privacy', '--json', '--prove', '--brief'])
    assert.equal(result.status, 0, result.stderr)
    const brief = JSON.parse(result.stdout)
    assert.equal(brief.ok, true)
    assert.equal(brief.mode, 'brief')
    assert.equal(brief.briefVersion, 1)
    assert.equal(brief.lines.length, 4)
    assert.deepEqual(brief.lines.map((line) => line.key), ['at-rest', 'sync', 'export', 'egress'])
    assert.equal(typeof brief.notice, 'string')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('privacy --prove without --brief keeps the full facts/self-check output', () => {
  const home = makeHome()
  try {
    const result = run(home, ['privacy', '--prove'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /privacy · local data facts/)
    assert.match(result.stdout, /self-checks/)
    assert.doesNotMatch(result.stdout, /^at-rest\s/m, 'the brief card is opt-in only')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('profile show --json is empty, stable and two-run identical', () => {
  const home = makeHome()
  try {
    const first = run(home, ['profile', 'show', '--json'])
    assert.equal(first.status, 0, first.stderr)
    const profile = JSON.parse(first.stdout)
    assert.equal(profile.ok, true)
    assert.equal(profile.mode, 'profile')
    assert.equal(profile.profileVersion, 1)
    assert.equal(profile.source, 'preferences')
    assert.equal(profile.count, 0)
    assert.deepEqual(profile.groups, [])
    assert.match(profile.dataSha256, /^[0-9a-f]{64}$/)
    const second = run(home, ['profile', 'show', '--json'])
    assert.equal(second.stdout, first.stdout, 'the same rows + now produce identical JSON')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('profile show human output and export --out write a 0600 markdown file', () => {
  const home = makeHome()
  try {
    const shown = run(home, ['profile', 'show'])
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /profile v1 · source=preferences · count=0 · dataSha256=[0-9a-f]{64}/)
    assert.match(shown.stdout, /还没有偏好记录/)
    const out = join(home, 'profile.md')
    const exported = run(home, ['profile', 'export', '--out', out])
    assert.equal(exported.status, 0, exported.stderr)
    assert.match(exported.stdout, /profile exported: .*0 preferences/)
    assertPrivateMode(out, 0o600, 'profile markdown')
    const markdown = readFileSync(out, 'utf8')
    assert.match(markdown, /^# 个人模型 · profile v1/)
    const jsonOut = join(home, 'profile.json')
    const jsonExport = run(home, ['profile', 'export', '--json', '--out', jsonOut])
    assert.equal(jsonExport.status, 0, jsonExport.stderr)
    assert.equal(JSON.parse(readFileSync(jsonOut, 'utf8')).count, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})