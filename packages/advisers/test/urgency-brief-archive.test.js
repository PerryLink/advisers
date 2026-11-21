import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import {
  BRIEF_LATEST_FILE,
  BRIEF_RETENTION_DAYS,
  archiveBrief,
  briefAuditRow,
  briefFilePath,
  briefPaths,
  listBriefs,
  readBrief,
  validateBriefDay,
} from '../lib/brief-archive.js'

const POSIX_MODES = process.platform !== 'win32'

function mkHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-brief-archive-'))
}

/** A real calendar day: 2026-01-01 + index days (so sorting is lexicographic). */
function dayNumber(index) {
  return new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)
}

test('archiveBrief writes the day file and latest copy atomically with owner-only permissions', () => {
  const home = mkHome()
  try {
    const first = archiveBrief({ home, localDay: '2026-11-21', markdown: '# 晨报 A\n' })
    assert.equal(first.ok, true)
    assert.equal(first.written, true)
    assert.equal(first.dryRun, false)
    assert.equal(first.localDay, '2026-11-21')
    assert.equal(first.path, join(home, 'briefs', '2026-11-21.md'))
    assert.equal(first.latestPath, join(home, 'briefs', BRIEF_LATEST_FILE))
    assert.equal(first.bytes, Buffer.byteLength('# 晨报 A\n'))
    assert.equal(readFileSync(first.path, 'utf8'), '# 晨报 A\n')
    assert.equal(readFileSync(first.latestPath, 'utf8'), '# 晨报 A\n')
    assert.equal(readBrief({ home, localDay: '2026-11-21' }).markdown, '# 晨报 A\n')
    if (POSIX_MODES) {
      assert.equal(statSync(first.path).mode & 0o777, 0o600)
      assert.equal(statSync(first.latestPath).mode & 0o777, 0o600)
      assert.equal(statSync(join(home, 'briefs')).mode & 0o777, 0o700)
    }
    // Re-running the same day atomically replaces both the day file and latest.md.
    const second = archiveBrief({ home, localDay: '2026-11-21', markdown: '# 晨报 B\n' })
    assert.equal(second.written, true)
    assert.equal(readFileSync(first.path, 'utf8'), '# 晨报 B\n')
    assert.equal(readFileSync(first.latestPath, 'utf8'), '# 晨报 B\n')
    assert.deepEqual(readdirSync(join(home, 'briefs')).sort(), ['2026-11-21.md', BRIEF_LATEST_FILE])
    // A missing day degrades to found:false (an archive is optional).
    const missing = readBrief({ home, localDay: '2026-11-20' })
    assert.equal(missing.found, false)
    assert.equal(missing.markdown, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('archiveBrief retention deletes only old day files and preserves unrelated entries', () => {
  const home = mkHome()
  try {
    const dir = join(home, 'briefs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'keep me')
    mkdirSync(join(dir, 'subdir'), { recursive: true })
    writeFileSync(join(dir, 'subdir', '2020-01-01.md'), 'nested')
    for (let index = 0; index < 20; index += 1) {
      archiveBrief({ home, localDay: dayNumber(index), markdown: 'brief ' + index, keep: 365 })
    }
    const result = archiveBrief({ home, localDay: '2026-11-21', markdown: '# 最新\n', keep: 14 })
    assert.equal(result.keep, 14)
    assert.equal(result.retained.length, 14)
    assert.equal(result.retained[0], '2026-11-21')
    const expectedKept = Array.from({ length: 13 }, (_, offset) => dayNumber(19 - offset))
    assert.deepEqual(result.retained.slice(1), expectedKept)
    assert.equal(result.removed.length, 7, '21 day files minus 14 retained')
    const removedDays = result.removed.map((path) => basename(path).slice(0, 10)).sort()
    assert.deepEqual(removedDays, Array.from({ length: 7 }, (_, index) => dayNumber(index)).sort())
    assert.ok(result.removed.every((path) => path.startsWith(dir)))
    assert.ok(result.removed.every((path) => !existsSync(path)))
    assert.deepEqual(result.failed, [])
    assert.ok(existsSync(join(dir, 'notes.txt')), 'unrelated files are never deleted')
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'keep me')
    assert.ok(existsSync(join(dir, 'subdir', '2020-01-01.md')), 'retention is never recursive')
    assert.ok(existsSync(join(dir, BRIEF_LATEST_FILE)), 'latest.md is never pruned')
    assert.equal(listBriefs({ home }).count, 14)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('archiveBrief dry-run plans the same changes without writing', () => {
  const home = mkHome()
  try {
    const plan = archiveBrief({ home, localDay: '2026-11-21', markdown: 'x', dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.equal(plan.written, false)
    assert.equal(plan.removed.length, 0)
    assert.equal(plan.audit.reason, '2026-11-21')
    assert.equal(existsSync(join(home, 'briefs')), false)
    for (let index = 0; index < 5; index += 1) archiveBrief({ home, localDay: dayNumber(index), markdown: 'b', keep: 365 })
    const before = readdirSync(join(home, 'briefs')).sort()
    const plan2 = archiveBrief({ home, localDay: '2026-11-21', markdown: 'x', keep: 2, dryRun: true })
    assert.equal(plan2.written, false)
    assert.equal(plan2.removed.length, 4, '6 candidate days minus 2 retained')
    assert.ok(plan2.removed.every((path) => existsSync(path)), 'a dry run never deletes')
    assert.deepEqual(readdirSync(join(home, 'briefs')).sort(), before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('invalid days, keep values and markdown are rejected before touching the filesystem', () => {
  for (const day of ['2026-02-30', '2026-13-01', '2026-1-1', '20261121', '', null, 42]) {
    assert.throws(() => validateBriefDay(day), (error) => error instanceof RangeError && error.code === 'E_USAGE', 'rejects ' + String(day))
  }
  assert.equal(validateBriefDay('2024-02-29'), '2024-02-29')
  const home = mkHome()
  try {
    assert.throws(() => archiveBrief({ home, localDay: '2026-11-21', markdown: 'x', keep: 0 }), RangeError)
    assert.throws(() => archiveBrief({ home, localDay: '2026-11-21', markdown: 'x', keep: 366 }), RangeError)
    assert.throws(() => archiveBrief({ home, localDay: '2026-11-21', markdown: 'x', keep: 1.5 }), RangeError)
    assert.throws(() => archiveBrief({ home, localDay: '2026-11-21', markdown: 42 }), TypeError)
    assert.throws(() => archiveBrief({ home, localDay: 'nope', markdown: 'x' }), RangeError)
    assert.throws(() => readBrief({ home, localDay: 'nope' }), RangeError)
    assert.throws(() => briefFilePath({ home, localDay: 'nope' }), RangeError)
    assert.throws(() => listBriefs({ home, limit: 0 }), RangeError)
    assert.equal(existsSync(join(home, 'briefs')), false, 'validation failures never create the archive')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the audit row suggestion contains the local day and never the brief body', () => {
  const home = mkHome()
  try {
    const result = archiveBrief({ home, localDay: '2026-11-21', markdown: '# 秘密客户标题\n' })
    assert.deepEqual(result.audit, { actor: 'local', action: 'brief.archive', allowed: true, reason: '2026-11-21' })
    assert.deepEqual(briefAuditRow({ localDay: '2026-11-21' }), result.audit)
    assert.ok(!JSON.stringify(result.audit).includes('秘密'))
    assert.throws(() => briefAuditRow({ localDay: 'nope' }), RangeError)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('listBriefs reports newest-first metadata and the latest copy without reading bodies', () => {
  const home = mkHome()
  try {
    const empty = listBriefs({ home })
    assert.equal(empty.ok, true)
    assert.equal(empty.exists, false)
    assert.equal(empty.count, 0)
    assert.deepEqual(empty.briefs, [])
    assert.equal(empty.latest.exists, false)
    for (const day of ['2026-11-19', '2026-11-21', '2026-11-20']) {
      archiveBrief({ home, localDay: day, markdown: '# ' + day + '\n' })
    }
    const list = listBriefs({ home })
    assert.equal(list.exists, true)
    assert.equal(list.count, 3)
    assert.deepEqual(list.briefs.map((brief) => brief.localDay), ['2026-11-21', '2026-11-20', '2026-11-19'])
    for (const brief of list.briefs) {
      assert.ok(brief.path.startsWith(join(home, 'briefs')))
      assert.ok(brief.bytes > 0)
      assert.equal(typeof brief.modifiedAt, 'string')
      assert.ok(!Object.hasOwn(brief, 'markdown'), 'listing never reads bodies')
    }
    assert.equal(list.latest.exists, true)
    assert.equal(list.latest.path, join(home, 'briefs', BRIEF_LATEST_FILE))
    const limited = listBriefs({ home, limit: 2 })
    assert.equal(limited.count, 3)
    assert.equal(limited.briefs.length, 2)
    assert.deepEqual(limited.briefs.map((brief) => brief.localDay), ['2026-11-21', '2026-11-20'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('brief paths resolve an explicit home over env and never write another home', () => {
  const homeA = mkHome()
  const homeB = mkHome()
  try {
    assert.deepEqual(briefPaths({ home: homeA, env: { ADVISERS_HOME: homeB } }), {
      home: resolve(homeA),
      dir: join(resolve(homeA), 'briefs'),
      latestFile: join(resolve(homeA), 'briefs', BRIEF_LATEST_FILE),
    })
    assert.equal(briefPaths({ env: { ADVISERS_HOME: homeB } }).home, resolve(homeB))
    assert.equal(briefFilePath({ home: homeA, localDay: '2026-11-21' }), join(resolve(homeA), 'briefs', '2026-11-21.md'))
    archiveBrief({ home: homeA, localDay: '2026-11-21', markdown: 'a' })
    assert.equal(existsSync(join(homeB, 'briefs')), false)
  } finally {
    rmSync(homeA, { recursive: true, force: true })
    rmSync(homeB, { recursive: true, force: true })
  }
})

test('retention never follows or deletes symlinked day files', { skip: process.platform === 'win32' }, () => {
  const home = mkHome()
  const outside = mkdtempSync(join(tmpdir(), 'advisers-brief-target-'))
  try {
    const dir = join(home, 'briefs')
    mkdirSync(dir, { recursive: true })
    const target = join(outside, '2020-01-01.md')
    writeFileSync(target, 'outside')
    symlinkSync(target, join(dir, '2020-01-01.md'))
    for (let index = 0; index < 16; index += 1) archiveBrief({ home, localDay: dayNumber(index), markdown: 'b', keep: 365 })
    archiveBrief({ home, localDay: '2026-11-21', markdown: 'x', keep: 2 })
    assert.ok(existsSync(target), 'symlink target outside briefs/ is untouched')
    assert.ok(existsSync(join(dir, '2020-01-01.md')), 'the symlink is not treated as a day file')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('the freshly archived day is never pruned by the same call', () => {
  const home = mkHome()
  try {
    archiveBrief({ home, localDay: '2026-11-21', markdown: 'newest' })
    const result = archiveBrief({ home, localDay: '2026-11-20', markdown: 'older', keep: 1 })
    assert.equal(result.removed.length, 0)
    assert.ok(existsSync(join(home, 'briefs', '2026-11-20.md')))
    assert.ok(existsSync(join(home, 'briefs', '2026-11-21.md')))
    assert.equal(readFileSync(join(home, 'briefs', BRIEF_LATEST_FILE), 'utf8'), 'older')
    assert.equal(BRIEF_RETENTION_DAYS, 14)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
