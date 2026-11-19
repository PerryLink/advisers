import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { tosEnv } from './tos-fixture.js'
import { SqliteStore } from '../lib/sqlite.js'

/**
 * 0.3.0 P0-T1: write amplification (TEMP B-TREE spill) regression, Linux only.
 *
 * The 0.2.x partial loaders appended ORDER BY rowid after a status predicate.
 * The v20 status-leading indexes cannot satisfy that order, so SQLite sorted
 * every match into a TEMP B-TREE and spilled it to disk: pet-brief wrote
 * 29 MB and today 5.6 MB per run at a 200k ledger. The read paths now use
 * index-friendly loaders / narrow projections, so every read command must stay
 * under 1 MiB of process writes (measured from /proc/<pid>/io write_bytes, max
 * sample -- the metric docs/PERFORMANCE.md uses).
 *
 * Wall-clock thresholds are deliberately NOT asserted here: CI uses behaviour,
 * not timing (repo policy). Windows has no /proc, so the test skips there.
 */

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const MIB = 1024 * 1024

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-no-spill-' + name + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work, db: join(home, 'state.db') }
}

/** 60k facts / 20k open commitments: big enough that the old sorts spilled >1 MiB. */
function seed(db) {
  const store = new SqliteStore(db)
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString()
  const day = 86_400_000
  store.db.exec('BEGIN')
  try {
    const matter = store.db.prepare('INSERT INTO matters(id,title,status,domain,secrecy,summary,participants,deadlines,open_questions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const fact = store.db.prepare('INSERT INTO facts(id,matter_id,subject,predicate,object,recorded_at,authority,confidence,source,status,evidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const commitment = store.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 20; i++) {
      matter.run('matter_spill_' + i, '客户项目-' + i, 'active', 'consulting', 0, null, '["王工"]', '[]', '[]', iso(now), iso(now))
    }
    for (let i = 0; i < 60_000; i++) {
      fact.run('fact_spill_' + i, 'matter_spill_' + (i % 20), '客户' + (i % 20), 'stated',
        '第' + i + '条：甲方要求' + (i % 7 + 1) + '月提交报价单', iso(now - i * 1000), 'user', 0.9, null, 'confirmed',
        JSON.stringify([{ quote: '甲方要求第' + i + '条按期交付' }]))
    }
    for (let i = 0; i < 20_000; i++) {
      const due = iso(now + (i % 60) * day)
      commitment.run('cm_spill_' + i, 'matter_spill_' + (i % 20), 'user', '王工', '发送第' + i + '版交付物',
        due, 'Asia/Shanghai', 'open', JSON.stringify([{ quote: '承诺第' + i + '条' }]), 'todo', null, null)
    }
    store.db.exec('COMMIT')
  } catch (error) {
    try { store.db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    store.close()
  }
}

function env(home) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
  })
}

/** Run the CLI and report the max /proc/<pid>/io write_bytes sample. */
function runWithWriteBytes(args, { home, work }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: work, env: env(home), stdio: ['ignore', 'ignore', 'ignore'] })
    let max = 0
    const poll = () => {
      try {
        const text = readFileSync('/proc/' + child.pid + '/io', 'utf8')
        const match = /write_bytes:\s*(\d+)/.exec(text)
        if (match) max = Math.max(max, Number(match[1]))
      } catch {}
    }
    poll()
    const timer = setInterval(poll, 2)
    child.on('exit', (code) => {
      clearInterval(timer)
      poll()
      resolve({ code, writeBytes: max })
    })
  })
}

test('read commands write under 1 MiB (no status+rowid TEMP B-TREE spill)', { skip: process.platform !== 'linux' ? 'no /proc/<pid>/io on this platform' : false }, async () => {
  const { root, home, work, db } = setup('commands')
  try {
    seed(db)
    const scenarios = [
      ['pet-brief', ['pet-brief']],
      ['pet-brief --json', ['pet-brief', '--json']],
      ['today', ['today']],
      ['today --json', ['today', '--json']],
      ['remind', ['remind', '--json']],
      ['tui --once', ['tui', '--once']],
      ['digest', ['digest', 'day']],
    ]
    for (const [label, args] of scenarios) {
      const result = await runWithWriteBytes(args, { home, work })
      assert.equal(result.code, 0, label + ' exited ' + result.code)
      assert.ok(result.writeBytes < MIB, label + ' wrote ' + result.writeBytes + ' bytes (>= 1 MiB); a status predicate is sorting again')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
