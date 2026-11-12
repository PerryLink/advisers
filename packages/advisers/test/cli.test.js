import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function cli(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' },
    encoding: 'utf8',
  })
}

test('CLI commitment add/tick/memory works end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-cli-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  try {
    const due = new Date(Date.now() + 2 * 3600_000).toISOString()
    const added = cli(home, ['commit', 'add', '发报价', '--quote', '周五前发', '--creditor', '王工', '--due', due], work)
    assert.match(added, /open 发报价/)
    const first = cli(home, ['tick'], work)
    assert.match(first, /发报价/)
    const second = cli(home, ['tick'], work)
    assert.match(second, /未来 7 天无到期/)
    assert.match(cli(home, ['memory'], work), /发报价/)
    assert.match(cli(home, ['week'], work), /发报价/)
    cli(home, ['correct', '以后周报先给结论'], work)
    assert.match(cli(home, ['memory', 'search', '周报'], work), /先给结论/)
    assert.match(cli(home, ['who'], work), /王工/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI rejects a missing file evidence for done', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-cli-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  try {
    const id = cli(home, ['commit', 'add', '发报价', '--quote', 'q'], work).split(/\s+/)[0]
    assert.throws(() => cli(home, ['commit', 'done', id, '--evidence', 'file:missing.docx'], work))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI builds an Office file and verifies it', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-cli-office-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  try {
    const spec = join(work, 'spec.json')
    writeFileSync(spec, JSON.stringify({ title: 'X', sections: [{ heading: 'A', paragraphs: ['B'] }] }))
    const out = join(work, 'out', 'x.docx')
    cli(home, ['office', 'docx', spec, out], work)
    const result = cli(home, ['verify', out], work)
    assert.match(result, /"ok": true/)
    assert.match(cli(home, ['office-read', out], work), /B/)
    assert.match(cli(home, ['undo', '--list'], work), /x\.docx/)
    const ops = join(work, 'ops.json')
    writeFileSync(ops, JSON.stringify([{ op: 'docx.setText', block: 2, text: 'C' }]))
    const edited = join(work, 'out', 'edited.docx')
    cli(home, ['office-edit', out, ops, edited], work)
    assert.match(cli(home, ['office-read', edited], work), /C/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI policy check and crisis short-circuit before the model', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-cli-policy-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  try {
    const check = cli(home, ['policy', 'check', '我不想活了'], work)
    assert.match(check, /"tier": "T2"/)
    assert.match(check, /"action": "crisis"/)
    const chat = cli(home, ['chat', '我不想活了'], work)
    assert.match(chat, /12356/)
    assert.doesNotMatch(chat, /\[local\] 未配置模型/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
