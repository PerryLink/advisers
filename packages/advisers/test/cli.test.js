import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function cli(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' },
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
    assert.match(second, /今天到期：无/)
    assert.match(cli(home, ['memory'], work), /发报价/)
    assert.match(cli(home, ['week'], work), /发报价/)
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
