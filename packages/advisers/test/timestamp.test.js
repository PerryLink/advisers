import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runLocalTimestamp } from '../lib/timestamp.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

test('P2: local timestamp adapter is opt-in and works with a local command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-ts-'))
  const old = process.env.ADVISERS_TIMESTAMP_CMD
  try {
    writeFileSync(join(root, 'pack.txt'), 'evidence')
    await assert.rejects(() => runLocalTimestamp('pack.txt', { cwd: root, cmd: '' }), /not configured/)
    const script = join(root, 'fake-ts.sh')
    writeFileSync(script, '#!/bin/sh\necho "TSA fake proof for $(basename "$1")"\n')
    chmodSync(script, 0o700)
    process.env.ADVISERS_TIMESTAMP_CMD = script
    assert.match(await runLocalTimestamp('pack.txt', { cwd: root }), /TSA fake proof/)
  } finally {
    if (old === undefined) delete process.env.ADVISERS_TIMESTAMP_CMD
    else process.env.ADVISERS_TIMESTAMP_CMD = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2: TUI --once renders a read-only dashboard', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-tui-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }
  try {
    execFileSync(process.execPath, [bin, 'commit', 'add', '发报价', '--quote', 'q'], { env, encoding: 'utf8' })
    const out = execFileSync(process.execPath, [bin, 'tui', '--once'], { env, encoding: 'utf8' })
    assert.match(out, /Advisers TUI/)
    assert.match(out, /open commitments/)
    assert.match(out, /发报价/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
