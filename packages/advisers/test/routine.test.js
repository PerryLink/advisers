import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkRoutine } from '../lib/routine.js'

test('routine file checks fail on missing and pass on non-empty files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-routine-'))
  try {
    assert.equal(checkRoutine({ verification: ['file:out/weekly.docx'] }, { cwd: dir }).ok, false)
    writeFileSync(join(dir, 'out.docx'), 'x')
    assert.equal(checkRoutine({ verification: ['file:out.docx'] }, { cwd: dir }).ok, true)
    assert.equal(checkRoutine({ verification: ['manual review'] }, { cwd: dir }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
