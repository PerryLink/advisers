import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const evidence = [{ sessionId: 'conv', turnId: 'turn', quote: 'q' }]

function env(home) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' })
}
function cli(home, args) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home), encoding: 'utf8' })
}
function localDayAfter(days) {
  const target = new Date(Date.now() + days * 86400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(target)
}

test('pet-brief projects every public non-default matter and explicitly excludes the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-pet-matter-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const a = ledger.addMatter({ title: '客户A' })
    const b = ledger.addMatter({ title: '客户B' })
    const secret = ledger.addMatter({ title: '秘密客户', secrecy: 2 })
    const due = localDayAfter(2)
    ledger.addCommitment({ matterId: a.id, debtor: 'user', creditor: '王工', action: '客户A的承诺', dueAt: due, evidence })
    ledger.addCommitment({ matterId: b.id, debtor: 'user', creditor: '李工', action: '客户B的承诺', dueAt: due, evidence })
    ledger.addCommitment({ matterId: secret.id, debtor: 'user', creditor: '秘密对象', action: '秘密承诺', dueAt: due, evidence })
    // Legacy/dangling ids: the old CLI could write a matter that never existed.
    ledger.addCommitment({ matterId: 'matter_client_wang', debtor: 'user', creditor: '王工', action: '悬空承诺', dueAt: due, evidence })
    ledger.addCommitment({ matterId: 'matter_client_wang', debtor: 'user', creditor: '王工', action: '悬空无截止', evidence })
    store.save(ledger.toJSON())
    store.close()
    const raw = cli(home, ['pet-brief', '--json'])
    const brief = JSON.parse(raw)
    assert.equal(brief.source, 'advisers')
    assert.equal(brief.counts.commitments, 2, 'both public matters are projected, not just the default one')
    const projected = brief.commitments.map((item) => item.what)
    assert.ok(projected.includes('客户A的承诺'))
    assert.ok(projected.includes('客户B的承诺'))
    const matterIds = brief.commitments.map((item) => item.matter)
    assert.ok(matterIds.includes(a.id))
    assert.ok(matterIds.includes(b.id))
    const notes = brief.redactions.join(' | ')
    assert.match(notes, /已排除保密事项下的承诺（1 条）/)
    assert.match(notes, /已排除无法归属的承诺（2 条，matter 不存在）/)
    assert.equal(brief.today.some((item) => item.title === '秘密客户'), false)
    for (const forbidden of ['秘密承诺', '悬空承诺', '悬空无截止', '秘密客户', '秘密对象']) {
      assert.equal(raw.includes(forbidden), false, 'excluded data must not leak: ' + forbidden)
    }
    // The brief still passes its own contract check.
    const checked = JSON.parse(cli(home, ['pet-brief', '--check']))
    assert.equal(checked.ok, true)
    assert.equal(checked.counts.commitments, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
