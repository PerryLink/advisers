import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function cli(home, args, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function cliFail(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-matter-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

test('matter add/ls/show/rename/archive round-trip; --all shows archived; ls alias kept', () => {
  const s = setup('crud')
  try {
    const added = JSON.parse(cli(s.home, ['matter', 'add', '王工 · 官网改版', '--secrecy', '1', '--domain', 'client-work', '--json']))
    assert.equal(added.ok, true)
    assert.match(added.matter.id, /^matter_/)
    assert.equal(added.matter.secrecy, 1)
    assert.equal(added.matter.domain, 'client-work')
    const id = added.matter.id
    let rows = JSON.parse(cli(s.home, ['matter', 'ls', '--json']))
    assert.ok(Array.isArray(rows))
    const row = rows.find((entry) => entry.id === id)
    assert.ok(row, 'matter ls --json contains the created matter')
    assert.equal(row.title, '王工 · 官网改版')
    assert.equal(row.openCommitments, 0)
    assert.equal(row.nextDueAt, null)
    assert.equal(row.clientId, null)
    const shown = JSON.parse(cli(s.home, ['matter', 'show', id, '--json']))
    assert.equal(shown.ok, true)
    assert.equal(shown.matter.id, id)
    assert.equal(shown.counts.open, 0)
    const renamed = JSON.parse(cli(s.home, ['matter', 'rename', id, '新标题', '--json']))
    assert.equal(renamed.matter.title, '新标题')
    assert.match(cli(s.home, ['ls']), /新标题/, 'legacy ls alias still lists matters')
    const dry = JSON.parse(cli(s.home, ['matter', 'archive', id, '--dry-run', '--json']))
    assert.equal(dry.dryRun, true)
    rows = JSON.parse(cli(s.home, ['matter', 'ls', '--json']))
    assert.equal(rows.find((entry) => entry.id === id).status, 'active', 'dry-run must not write')
    const archived = JSON.parse(cli(s.home, ['matter', 'archive', id, '--json']))
    assert.equal(archived.matter.status, 'archived')
    rows = JSON.parse(cli(s.home, ['matter', 'ls', '--json']))
    assert.equal(rows.some((entry) => entry.id === id), false, 'archived matters are hidden by default')
    rows = JSON.parse(cli(s.home, ['matter', 'ls', '--all', '--json']))
    assert.equal(rows.find((entry) => entry.id === id).status, 'archived')
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('commit add --matter ghost fails closed with E_MATTER_NOT_FOUND and writes no row', () => {
  const s = setup('ghost')
  try {
    const bad = cliFail(s.home, ['commit', 'add', '发报价', '--quote', '周五前发报价', '--matter', 'matter_ghost'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr + bad.stdout, /E_MATTER_NOT_FOUND/)
    const rows = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))
    assert.deepEqual(rows, [], 'a rejected --matter must not write a dangling commitment')
    const created = JSON.parse(cli(s.home, ['matter', 'add', '真实事项', '--json'])).matter
    const added = cli(s.home, ['commit', 'add', '发报价', '--quote', 'q', '--matter', created.id])
    assert.match(added, /open 发报价/)
    const stored = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))
    assert.equal(stored.length, 1)
    assert.equal(stored[0].matterId, created.id)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('commit add without --matter still lands in the default matter', () => {
  const s = setup('default')
  try {
    const out = cli(s.home, ['commit', 'add', '默认事项承诺', '--quote', 'q'])
    assert.match(out, /open 默认事项承诺/)
    const stored = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))
    assert.equal(stored.length, 1)
    assert.match(stored[0].matterId, /^matter_/)
    const matters = JSON.parse(cli(s.home, ['matter', 'ls', '--json']))
    assert.equal(matters.length, 1)
    assert.equal(matters[0].title, '默认事项')
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('matter use sets the default matter for later writes; archived/missing ids are rejected', () => {
  const s = setup('use')
  try {
    const a = JSON.parse(cli(s.home, ['matter', 'add', '客户A', '--json'])).matter
    const b = JSON.parse(cli(s.home, ['matter', 'add', '客户B', '--json'])).matter
    cli(s.home, ['commit', 'add', '第一件', '--quote', 'q'])
    const used = JSON.parse(cli(s.home, ['matter', 'use', b.id, '--json']))
    assert.equal(used.ok, true)
    assert.equal(used.matterId, b.id)
    cli(s.home, ['commit', 'add', '第二件', '--quote', 'q'])
    const stored = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))
    assert.equal(stored.find((row) => row.action === '第一件').matterId, a.id)
    assert.equal(stored.find((row) => row.action === '第二件').matterId, b.id)
    const missing = cliFail(s.home, ['matter', 'use', 'matter_ghost'])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /E_MATTER_NOT_FOUND/)
    cli(s.home, ['matter', 'archive', b.id])
    const archivedUse = cliFail(s.home, ['matter', 'use', b.id])
    assert.equal(archivedUse.status, 1)
    assert.match(archivedUse.stderr, /E_MATTER_ARCHIVED/)
    const archivedWrite = cliFail(s.home, ['commit', 'add', '第三件', '--quote', 'q', '--matter', b.id])
    assert.equal(archivedWrite.status, 1)
    assert.match(archivedWrite.stderr, /E_MATTER_ARCHIVED/)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('commit edit --matter validates and moves the commitment', () => {
  const s = setup('edit')
  try {
    const a = JSON.parse(cli(s.home, ['matter', 'add', '客户A', '--json'])).matter
    const b = JSON.parse(cli(s.home, ['matter', 'add', '客户B', '--json'])).matter
    const added = cli(s.home, ['commit', 'add', '发报价', '--quote', 'q', '--matter', a.id])
    const id = added.split(/\s+/)[0]
    assert.match(cli(s.home, ['commit', 'edit', id, '--matter', b.id]), /updated: /)
    let stored = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))
    assert.equal(stored[0].matterId, b.id)
    const bad = cliFail(s.home, ['commit', 'edit', id, '--matter', 'matter_ghost'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr + bad.stdout, /E_MATTER_NOT_FOUND/)
    stored = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))
    assert.equal(stored[0].matterId, b.id, 'a rejected edit must not change the row')
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})
