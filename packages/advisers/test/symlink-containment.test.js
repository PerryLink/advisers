import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertOcrPath, runLocalOcr } from '../lib/ocr.js'
import { assertProofFile, runLocalTimestamp } from '../lib/timestamp.js'

const skip = process.platform === 'win32' ? 'POSIX shell adapter test' : false

function makeAdapter(root, marker) {
  const script = join(root, 'adapter.sh')
  writeFileSync(script, '#!/bin/sh\necho spawned > ' + JSON.stringify(marker) + '\ncat "$1"\n')
  chmodSync(script, 0o700)
  return script
}

test('OCR rejects a symlink that points outside the workspace before spawning', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'adv023-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'adv023-symlink-out-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE-CONTENT')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'planted.png'))
    const marker = join(root, 'spawn.marker')
    const script = makeAdapter(root, marker)
    await assert.rejects(() => runLocalOcr('planted.png', { cwd: root, cmd: script }), /escapes workspace through a symlink/)
    assert.equal(existsSync(marker), false, 'the adapter must not be spawned for a rejected path')
    assert.throws(() => assertOcrPath('planted.png', root), /symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('OCR rejects a symlinked parent directory that escapes the workspace', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'adv023-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'adv023-symlink-out-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE-CONTENT')
    symlinkSync(outside, join(root, 'linkdir'))
    const script = makeAdapter(root, join(root, 'spawn.marker'))
    await assert.rejects(() => runLocalOcr('linkdir/secret.txt', { cwd: root, cmd: script }), /escapes workspace through a symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('OCR still accepts a symlink that stays inside the workspace', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'adv023-symlink-'))
  try {
    writeFileSync(join(root, 'scan.txt'), 'INSIDE-OCR-TEXT')
    symlinkSync(join(root, 'scan.txt'), join(root, 'inside-link.png'))
    const script = makeAdapter(root, join(root, 'spawn.marker'))
    assert.match(await runLocalOcr('inside-link.png', { cwd: root, cmd: script }), /INSIDE-OCR-TEXT/)
    assert.equal(assertOcrPath('inside-link.png', root), join(root, 'scan.txt'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('timestamp rejects a symlink that points outside the workspace before spawning', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'adv023-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'adv023-symlink-out-'))
  try {
    writeFileSync(join(outside, 'pack.txt'), 'SECRET-OUTSIDE-CONTENT')
    symlinkSync(join(outside, 'pack.txt'), join(root, 'planted.txt'))
    const marker = join(root, 'spawn.marker')
    const script = makeAdapter(root, marker)
    await assert.rejects(() => runLocalTimestamp('planted.txt', { cwd: root, cmd: script }), /escapes workspace through a symlink/)
    assert.equal(existsSync(marker), false, 'the adapter must not be spawned for a rejected path')
    assert.throws(() => assertProofFile('planted.txt', root), /symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('timestamp still accepts a normal file and a contained symlink', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'adv023-symlink-'))
  try {
    writeFileSync(join(root, 'pack.txt'), 'TSA-PROOF')
    symlinkSync(join(root, 'pack.txt'), join(root, 'inside.txt'))
    const script = makeAdapter(root, join(root, 'spawn.marker'))
    assert.match(await runLocalTimestamp('inside.txt', { cwd: root, cmd: script }), /TSA-PROOF/)
    assert.equal(assertProofFile('inside.txt', root), join(root, 'pack.txt'))
    await assert.rejects(() => runLocalTimestamp('../outside.txt', { cwd: root, cmd: script }), /escapes workspace/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
