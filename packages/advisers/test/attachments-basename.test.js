import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { extractAttachment } from '../lib/attachments.js'

// Robustness audit 2026-11-17 P2-6 / round-1 P1-8: extractAttachment used
// `path.split('/').pop()` for the attachment name. On Windows safePath()
// resolves to a backslash path, so the whole absolute path became the name and
// leaked into capture metadata/output. It must use path.basename(), which is
// separator-aware on the host platform.

const libFile = fileURLToPath(new URL('../lib/attachments.js', import.meta.url))

test('attachment name is the basename of a nested file, never the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-attach-name-'))
  try {
    mkdirSync(join(dir, 'deals', 'q4'), { recursive: true })
    writeFileSync(join(dir, 'deals', 'q4', 'notes.md'), '# 正文')
    const extracted = await extractAttachment('deals/q4/notes.md', { cwd: dir })
    assert.equal(extracted.name, 'notes.md')
    assert.equal(extracted.name, basename(extracted.path))
    assert.equal(extracted.name.includes('/'), false)
    assert.equal(extracted.name.includes(dir), false, 'the attachment name must not leak the absolute path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attachment name uses path.basename (Windows separator fix)', () => {
  const source = readFileSync(libFile, 'utf8')
  assert.match(source, /import \{[^}]*\bbasename\b[^}]*\} from 'node:path'/, 'basename must be imported from node:path')
  assert.match(source, /const name = basename\(path\)/, 'the resolved path must go through basename()')
  assert.equal(/path\.split\(['"]\/['"]\)\.pop\(\)/.test(source), false, 'the POSIX-only path.split(\'/\').pop() must be gone')
})
