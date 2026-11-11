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
