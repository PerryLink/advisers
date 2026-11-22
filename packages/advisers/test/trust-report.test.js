import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  DOCTOR_LIMITATIONS,
  DOCTOR_MEASURED_DIMENSIONS,
  DOCTOR_MEASURED_KEYS,
  DOCTOR_NOTICES,
  DOCTOR_REPORT_VERSION,
  PRIVACY_BRIEF_LINES,
  PRIVACY_BRIEF_VERSION,
  buildDoctorReport,
  buildPrivacyBrief,
  formatPrivacyBrief,
} from '../lib/trust-report.js'

// 043-3 trust outputs: `doctor --report` unknown-is-null and the
// `privacy --prove --brief` four-line card. These suites cover the library
// contract only (bin wiring is a separate change); they never touch a real
// home, never spawn a process and never open a network socket.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXED_AT = '2026-11-22T00:00:00.000Z'
const UNKNOWN_NOT_ZERO = new RegExp('"(?:' + DOCTOR_MEASURED_KEYS.join('|') + ')"\\s*:\\s*(?:0|false|"PASS")')

function readDoc(relative) {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

test('doctor report: every unknown dimension is explicit null with a reason, never 0/false/PASS', () => {
  const report = buildDoctorReport({ generatedAt: FIXED_AT, advisersVersion: '0.4.3', schemaVersion: 22 })
  assert.deepEqual(Object.keys(report).sort(), [
    'advisersVersion', 'generatedAt', 'limitations', 'measured', 'mode', 'notices', 'nulls', 'ok', 'reportVersion', 'schemaVersion',
  ])
  assert.equal(report.ok, true)
  assert.equal(report.mode, 'report')
  assert.equal(report.reportVersion, DOCTOR_REPORT_VERSION)
  assert.equal(report.generatedAt, FIXED_AT)
  assert.equal(report.advisersVersion, '0.4.3')
  assert.equal(report.schemaVersion, 22)
  assert.deepEqual(Object.keys(report.measured), DOCTOR_MEASURED_KEYS)
  assert.equal(report.measured.modelQuality, null)
  assert.equal(report.measured.semanticCorrectness, null)
  assert.equal(report.measured.independentGoldStandard, null)
  assert.equal(report.measured.realMailAccount, null, 'an unprobed real account is null, not false')
  assert.equal(report.measured.win11RealMachine, null, 'an unverified real machine is null, not false')
  for (const key of DOCTOR_MEASURED_KEYS) {
    assert.equal(report.measured[key], null, key + ' must stay null until measured')
    const entries = report.nulls.filter((entry) => entry.key === key)
    assert.equal(entries.length, 1, key + ' must have exactly one nulls[] reason')
    assert.equal(entries[0].reason, DOCTOR_MEASURED_DIMENSIONS[key])
    assert.ok(entries[0].reason.length > 20, key + ' reason must explain the gap')
  }
  assert.equal(report.nulls.length, DOCTOR_MEASURED_KEYS.length)
  const json = JSON.stringify(report)
  assert.doesNotMatch(json, UNKNOWN_NOT_ZERO, 'no quality dimension may be 0/false/PASS')
  assert.doesNotMatch(json, /"(?:modelQuality|semanticCorrectness|captureQuality|independentGoldStandard|externalTimestamp)"\s*:\s*(?:true|\d)/)
  assert.ok(Array.isArray(report.notices) && report.notices.length >= DOCTOR_NOTICES.length)
  assert.ok(Array.isArray(report.limitations) && report.limitations.length >= DOCTOR_LIMITATIONS.length)
  for (const line of [...report.notices, ...report.limitations]) assert.equal(typeof line, 'string')
})

test('doctor report: ok mirrors the caller check table and extras are appended (deduped, single-line)', () => {
  const failing = buildDoctorReport({ ok: false, generatedAt: FIXED_AT })
  assert.equal(failing.ok, false, 'a failed check table makes the report not-ok without implying quality')
  const annotated = buildDoctorReport({
    generatedAt: FIXED_AT,
    notices: ['backup age: 3 days', DOCTOR_NOTICES[0], '\u001b[31mred\u001b[0m\nsecond line'],
    limitations: ['offline run'],
  })
  assert.ok(annotated.notices.includes('backup age: 3 days'))
  assert.equal(annotated.notices.filter((line) => line === DOCTOR_NOTICES[0]).length, 1, 'duplicates are removed')
  const injected = annotated.notices.find((line) => line.includes('red'))
  assert.equal(injected, 'red second line', 'terminal escapes and newlines are stripped')
  assert.ok(annotated.limitations.includes('offline run'))
  assert.throws(() => buildDoctorReport({ ok: 'yes' }), TypeError)
  assert.throws(() => buildDoctorReport({ generatedAt: 'not-a-date' }), TypeError)
  assert.throws(() => buildDoctorReport({ schemaVersion: -1 }), TypeError)
  assert.throws(() => buildDoctorReport({ schemaVersion: 1.5 }), TypeError)
  assert.throws(() => buildDoctorReport({ notices: 'one line' }), TypeError)
  assert.throws(() => buildDoctorReport({ notices: [''] }), TypeError)
  assert.throws(() => buildDoctorReport({ limitations: [42] }), TypeError)
  assert.throws(() => buildDoctorReport({ advisersVersion: 42 }), TypeError)
})

test('doctor report: runtime schemaVersion comes from an explicit value or the opened SQLite store', () => {
  assert.equal(buildDoctorReport({ schemaVersion: 23 }).schemaVersion, 23)
  assert.equal(buildDoctorReport({ store: { schemaVersion: () => 22 } }).schemaVersion, 22)
  assert.equal(buildDoctorReport({ store: { schemaVersion: () => { throw new Error('sealed') } } }).schemaVersion, null)
  assert.equal(buildDoctorReport({ store: { schemaVersion: () => '22' } }).schemaVersion, null)
  assert.equal(buildDoctorReport({ schemaVersion: null, store: { schemaVersion: () => 22 } }).schemaVersion, null, 'an explicit null wins (JSON store)')
  assert.equal(buildDoctorReport().schemaVersion, null)
})

test('doctor report: deterministic given the same clock and version fallback', () => {
  const first = buildDoctorReport({ generatedAt: FIXED_AT, schemaVersion: 22, advisersVersion: '0.4.3' })
  const second = buildDoctorReport({ generatedAt: FIXED_AT, schemaVersion: 22, advisersVersion: '0.4.3' })
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  const fallback = buildDoctorReport({ generatedAt: FIXED_AT })
  assert.match(String(fallback.advisersVersion), /^\d+\.\d+\.\d+/, 'the packaged version is the fallback')
  const live = buildDoctorReport()
  assert.ok(Number.isFinite(Date.parse(live.generatedAt)), 'generatedAt defaults to now as an ISO string')
})

test('privacy brief: exactly four ordered lines sourced from the privacy/sync/at-rest docs', () => {
  const brief = buildPrivacyBrief({ generatedAt: FIXED_AT })
  assert.equal(brief.ok, true)
  assert.equal(brief.mode, 'brief')
  assert.equal(brief.briefVersion, PRIVACY_BRIEF_VERSION)
  assert.equal(brief.generatedAt, FIXED_AT)
  assert.equal(typeof brief.notice, 'string')
  assert.ok(brief.notice.includes('不是第三方审计'))
  assert.equal(brief.lines.length, 4)
  assert.deepEqual(brief.lines.map((line) => line.key), ['at-rest', 'sync', 'export', 'egress'])
  assert.deepEqual(PRIVACY_BRIEF_LINES.map((line) => line.key), ['at-rest', 'sync', 'export', 'egress'])
  for (const line of brief.lines) {
    assert.equal(line.label, line.key)
    for (const field of ['claim', 'state', 'command', 'docs']) assert.ok(String(line[field]).length > 0, line.key + ' ' + field)
    assert.ok(Array.isArray(line.docsClaims) && line.docsClaims.length > 0, line.key + ' names its doc claims')
    const doc = readDoc(line.docs)
    for (const claim of line.docsClaims) {
      assert.ok(doc.includes(claim), line.key + ' docsClaim ' + JSON.stringify(claim) + ' must exist in ' + line.docs)
    }
  }
  const formatted = formatPrivacyBrief(brief)
  assert.equal(formatted.length, 4)
  const control = /[\u0000-\u001f\u007f-\u009f]/
  for (const [index, line] of formatted.entries()) {
    const source = brief.lines[index]
    assert.ok(line.startsWith(source.label), 'line starts with its label')
    assert.ok(line.includes(source.claim), 'line carries the claim')
    assert.ok(line.includes('[' + source.docs + ']'), 'line cites the owning doc')
    assert.doesNotMatch(line, control, 'a card line must stay single-line and terminal-safe')
  }
  assert.deepEqual(formatPrivacyBrief(buildPrivacyBrief({ generatedAt: FIXED_AT })), formatted)
})

test('privacy brief: claims project the four docs instead of telling a second story', () => {
  const brief = buildPrivacyBrief({ generatedAt: FIXED_AT })
  const byKey = new Map(brief.lines.map((line) => [line.key, line]))
  // language-neutral fragments that must appear in both the card and its doc
  const shared = {
    'at-rest': ['AES-256-GCM', 'opt-in'],
    sync: ['AES-256-GCM'],
    export: ['export --all', '--encrypted'],
    egress: ['不会出网'],
  }
  for (const [key, fragments] of Object.entries(shared)) {
    const line = byKey.get(key)
    for (const fragment of fragments) {
      assert.ok(line.claim.includes(fragment), key + ' claim must contain ' + fragment)
      assert.ok(readDoc(line.docs).includes(fragment), line.docs + ' must contain ' + fragment)
    }
  }
  assert.ok(byKey.get('at-rest').claim.includes('默认明文'))
  assert.match(byKey.get('sync').claim, /last-snapshot-wins/i)
  assert.match(readDoc('docs/SYNC.md'), /Last-snapshot-wins/i)
})

test('privacy brief: vault state is reported when known, never invented', () => {
  const unknown = buildPrivacyBrief({ generatedAt: FIXED_AT })
  assert.equal(unknown.lines[0].state, 'plaintext-by-default')
  const sealed = buildPrivacyBrief({ generatedAt: FIXED_AT, vaultSealed: true })
  assert.equal(sealed.lines[0].state, 'sealed-vault')
  const plain = buildPrivacyBrief({ generatedAt: FIXED_AT, vaultSealed: false })
  assert.equal(plain.lines[0].state, 'plaintext-db')
  for (const index of [1, 2, 3]) assert.equal(sealed.lines[index].state, unknown.lines[index].state)
  assert.throws(() => buildPrivacyBrief({ generatedAt: 'nope' }), TypeError)
  assert.throws(() => formatPrivacyBrief(null), TypeError)
  assert.throws(() => formatPrivacyBrief({ lines: 'x' }), TypeError)
  assert.ok(Object.isFrozen(PRIVACY_BRIEF_LINES))
  assert.ok(Object.isFrozen(DOCTOR_MEASURED_DIMENSIONS))
})

test('trust outputs are local-only: the module imports no network/model stack and writes no files', () => {
  const source = readFileSync(new URL('../lib/trust-report.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\s+[^\n]*?from\s+'([^']+)'/gm)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['./text-safe.js', 'node:fs'], 'only the text sanitiser and the read-only version fallback')
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dgram|child_process)/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream)\b/)
  assert.doesNotMatch(source, /import\s*\(/)
})
