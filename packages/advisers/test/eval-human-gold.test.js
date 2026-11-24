import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PACKET = join(REPO_ROOT, 'eval', 'human-gold', 'make-review-packet.mjs')
const AGREEMENT = join(REPO_ROOT, 'eval', 'human-gold', 'compute-agreement.mjs')
const ADJUDICATE = join(REPO_ROOT, 'eval', 'human-gold', 'adjudicate.mjs')
const LABEL_HEADER = 'id\taction\tdebtor\tcreditor\tdue\tquote\tmodal\tconfidence\tnotes'
const ADJUDICATION_HEADER = 'id\tagree\tfinal_commitments\tnotes'

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 })
}
function parseJson(run) {
  try { return JSON.parse(run.stdout) } catch { throw new Error('stdout is not JSON (status ' + run.status + '): ' + run.stdout + ' stderr: ' + run.stderr) }
}

const working = mkdtempSync(join(tmpdir(), 'advisers-human-gold-test-'))
const corpusPath = join(working, 'corpus.jsonl')
const packetPath = join(working, 'packet')
const ids = ['hg-001', 'hg-002', 'hg-003', 'hg-004', 'hg-005', 'hg-006']
const actions = ['发报价', '交报告', '付尾款', '发报价', '交报告', '付尾款']
const dueDates = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']
const rows = ids.map((id, index) => ({
  id,
  source: 'wechat',
  date: '2026-11-' + String(10 + index).padStart(2, '0') + 'T09:00:00+08:00',
  text: '测试消息 ' + id,
  expect: [{ action: actions[index], debtor: 'user', creditor: '王工', due: dueDates[index], quote: '原文引句 ' + id, modal: 'firm' }],
  provenance: 'synthetic',
  pending_human_review: true,
}))
writeFileSync(corpusPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

function labelSheet(values, overrides = {}) {
  const lines = [LABEL_HEADER]
  for (const [index, id] of ids.entries()) {
    const value = overrides[id] ?? values[index]
    lines.push([id, value.action, value.debtor, value.creditor, value.due, value.quote, value.modal, '', ''].join('\t'))
  }
  return lines.join('\n') + '\n'
}
const consensus = ids.map((id) => ({ action: actions[ids.indexOf(id)], debtor: 'user', creditor: '王工', due: dueDates[ids.indexOf(id)], quote: '原文引句 ' + id, modal: 'firm' }))
const sheetA = labelSheet(consensus)
const sheetB = labelSheet(consensus)
const sheetBDisagrees = labelSheet(consensus, { 'hg-006': { ...consensus[5], action: '发报价' } })

test('packet v2 is blind, stays outside the repo and refuses an in-repo output', () => {
  const result = run(PACKET, ['--corpus', corpusPath, '--out', packetPath])
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(join(packetPath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.format, 'advisers-human-gold-packet')
  assert.equal(manifest.version, 2)
  assert.equal(manifest.rows, ids.length)
  assert.match(manifest.corpusSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(manifest.reviewers, ['reviewer-a', 'reviewer-b'])
  assert.equal(readFileSync(join(packetPath, 'adjudication.tsv'), 'utf8').trim(), ADJUDICATION_HEADER)
  assert.ok(readFileSync(join(packetPath, 'labels-reviewer-a.tsv'), 'utf8').startsWith(LABEL_HEADER))
  assert.ok(existsSync(join(packetPath, 'adjudicator-only', 'reference-labels.jsonl')))
  assert.ok(existsSync(join(packetPath, 'annotation-guide.zh.md')))
  const cases = readFileSync(join(packetPath, 'cases.tsv'), 'utf8')
  assert.ok(cases.includes('测试消息 hg-001'))
  assert.ok(!cases.includes('expect'))
  const refused = run(PACKET, ['--corpus', corpusPath, '--out', join(REPO_ROOT, 'eval', 'human-gold', 'should-not-exist')])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /outside the repository/)
})

test('agreement: identical independent sheets give a defined kappa and pass the gate', () => {
  const a = join(working, 'labels-a.tsv')
  const b = join(working, 'labels-b.tsv')
  writeFileSync(a, sheetA)
  writeFileSync(b, sheetB)
  const out = join(working, 'agreement.json')
  const result = run(AGREEMENT, ['--a', a, '--b', b, '--out', out])
  assert.equal(result.status, 0, result.stderr)
  const agreement = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(agreement.cases, ids.length)
  assert.equal(agreement.commitmentSlots, ids.length)
  assert.equal(agreement.overall.kappa, 1)
  assert.equal(agreement.gate.passed, true)
  assert.equal(agreement.caseAgreement.exact, ids.length)
  assert.equal(agreement.privacy.containsCaseText, false)
  assert.equal(agreement.privacy.containsRawLabelValues, false)
  for (const field of ['action', 'debtor', 'creditor', 'due', 'quote', 'modal']) assert.ok(agreement.perField[field], field)
})

test('agreement: scope mismatches, blank sheets and same-id-set violations fail closed', () => {
  const headerOnly = join(working, 'labels-blank.tsv')
  const a = join(working, 'labels-a.tsv')
  writeFileSync(headerOnly, LABEL_HEADER + '\n')
  const blank = run(AGREEMENT, ['--a', headerOnly, '--b', headerOnly])
  assert.equal(blank.status, 1)
  assert.match(blank.stderr, /no labelled commitments/)
  const shorter = join(working, 'labels-short.tsv')
  writeFileSync(shorter, sheetA.split('\n').slice(0, 3).join('\n') + '\n')
  const mismatch = run(AGREEMENT, ['--a', a, '--b', shorter])
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, /different id sets/)
})

test('adjudication: consensus + one resolved disagreement freezes human gold metadata', () => {
  const a = join(working, 'labels-a.tsv')
  const b = join(working, 'labels-b-disagree.tsv')
  writeFileSync(b, sheetBDisagrees)
  const adjudication = join(working, 'adjudication.tsv')
  const final = JSON.stringify([{ ...consensus[5], action: '付尾款' }])
  writeFileSync(adjudication, [ADJUDICATION_HEADER, ['hg-006', 'no', final, 'reviewer A wins: quote matches the final verb'].join('\t')].join('\n') + '\n')
  const out = join(working, 'frozen')
  const result = run(ADJUDICATE, ['--a', a, '--b', b, '--adjudication', adjudication, '--corpus', corpusPath, '--reviewer-a-id', 'reviewer-a', '--reviewer-b-id', 'reviewer-b', '--reviewed-at', '2027-01-05T10:00:00+08:00', '--out', out])
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  assert.equal(manifest.frozen, true)
  assert.equal(manifest.reviewMode, 'human_double_review')
  assert.equal(manifest.gate.passed, true)
  assert.equal(manifest.adjudicatedCases, 1)
  assert.match(manifest.output.sha256, /^[0-9a-f]{64}$/)
  const gold = readFileSync(join(out, 'commitments.zh.gold.human.v1.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(gold.length, ids.length)
  for (const row of gold) {
    assert.equal(row.review_mode, 'human_double_review')
    assert.equal(row.pending_human_review, false)
    assert.deepEqual(row.reviewers, ['reviewer-a', 'reviewer-b'])
  }
  const hg006 = gold.find((row) => row.id === 'hg-006')
  assert.equal(hg006.expect[0].action, '付尾款')
})

test('adjudication: unresolved disagreements never freeze', () => {
  const a = join(working, 'labels-a.tsv')
  const b = join(working, 'labels-b-disagree.tsv')
  const emptyAdjudication = join(working, 'adjudication-empty.tsv')
  writeFileSync(emptyAdjudication, ADJUDICATION_HEADER + '\n')
  const out = join(working, 'must-not-freeze')
  const result = run(ADJUDICATE, ['--a', a, '--b', b, '--adjudication', emptyAdjudication, '--corpus', corpusPath, '--reviewer-a-id', 'reviewer-a', '--reviewer-b-id', 'reviewer-b', '--reviewed-at', '2027-01-05T10:00:00+08:00', '--out', out])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no adjudication/)
  assert.equal(existsSync(join(out, 'commitments.zh.gold.human.v1.jsonl')), false)
})

test('adjudication: kappa below the frozen threshold is recorded as frozen:false', () => {
  const a = join(working, 'labels-low-a.tsv')
  const b = join(working, 'labels-low-b.tsv')
  const rotated = ['交报告', '付尾款', '发报价', '交报告', '付尾款', '发报价']
  const opposite = ids.map((id, index) => ({ ...consensus[index], action: rotated[index] }))
  writeFileSync(a, labelSheet(consensus))
  writeFileSync(b, labelSheet(opposite))
  const adjudication = join(working, 'adjudication-low.tsv')
  const decisions = ids.map((id, index) => [id, 'no', JSON.stringify([consensus[index]]), 'reviewer A wins'].join('\t'))
  writeFileSync(adjudication, [ADJUDICATION_HEADER, ...decisions].join('\n') + '\n')
  const out = join(working, 'failed-pilot')
  const result = run(ADJUDICATE, ['--a', a, '--b', b, '--adjudication', adjudication, '--corpus', corpusPath, '--reviewer-a-id', 'reviewer-a', '--reviewer-b-id', 'reviewer-b', '--reviewed-at', '2027-01-05T10:00:00+08:00', '--out', out])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /kappa gate/)
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  assert.equal(manifest.frozen, false)
  assert.equal(manifest.gate.passed, false)
  assert.equal(existsSync(join(out, 'commitments.zh.gold.human.v1.jsonl')), false)
})
