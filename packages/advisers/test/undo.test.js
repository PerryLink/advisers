import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backupBeforeWrite, listBackups, undoLatest } from '../lib/undo.js'

test('backup/undo restores an overwritten file and deletes a newly created file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-undo-'))
  const work = join(root, 'work')
  const backups = join(root, 'undo')
  rmSync(work, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  await import('node:fs/promises').then((fs) => fs.mkdir(work, { recursive: true }))
  try {
    writeFileSync(join(work, 'a.txt'), 'old')
    await backupBeforeWrite('a.txt', { cwd: work, backupDir: backups })
    writeFileSync(join(work, 'a.txt'), 'new')
    assert.equal((await undoLatest({ cwd: work, backupDir: backups })).ok, true)
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'old')

    await backupBeforeWrite('b.txt', { cwd: work, backupDir: backups })
    writeFileSync(join(work, 'b.txt'), 'created')
    assert.equal((await undoLatest({ cwd: work, backupDir: backups })).ok, true)
    assert.equal(existsSync(join(work, 'b.txt')), false)
    assert.equal((await listBackups(backups)).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diffLatest shows line changes before undo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-diff-'))
  const work = join(root, 'work')
  const backups = join(root, 'undo')
  await import('node:fs/promises').then((fs) => fs.mkdir(work, { recursive: true }))
  try {
    writeFileSync(join(work, 'a.txt'), 'old\nline')
    await backupBeforeWrite('a.txt', { cwd: work, backupDir: backups })
    writeFileSync(join(work, 'a.txt'), 'new\nline')
    const diff = await (await import('../lib/undo.js')).diffLatest({ cwd: work, backupDir: backups })
    assert.match(diff.diff, /- old/)
    assert.match(diff.diff, /\+ new/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('undo does not cross workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-undo-ws-'))
  const a = join(root, 'a'); const b = join(root, 'b'); const backups = join(root, 'undo')
  const fs = await import('node:fs/promises')
  await fs.mkdir(a, { recursive: true }); await fs.mkdir(b, { recursive: true })
  try {
    writeFileSync(join(a, 'report.docx'), 'A')
    await backupBeforeWrite('report.docx', { cwd: a, backupDir: backups })
    writeFileSync(join(b, 'report.docx'), 'B')
    assert.equal((await undoLatest({ cwd: b, backupDir: backups })).ok, false)
    assert.equal(readFileSync(join(b, 'report.docx'), 'utf8'), 'B')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
