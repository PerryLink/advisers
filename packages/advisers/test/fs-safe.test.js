import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { assertPrivateMode } from './win-compat.mjs'
import {
  atomicWriteFileSync,
  commitTempFileSync,
  copyFileWithRetrySync,
  describeFsError,
  fsyncDirSync,
  fsyncFileSync,
  retryFsSync,
  rmWithRetrySync,
  tempPathForSync,
  tempPrefixForSync,
  writeAllSync,
  writeAllToTempSync,
} from '../lib/fs-safe.js'

// 0.2.3 robustness Phase 0 (P1-2/P1-3/P1-7): fs-safe must turn POSIX short
// writes / ENOSPC / transient Windows EPERM into either a complete file or an
// explicit error with no temp leftovers -- never a silently truncated output.
// All fault injection below uses a node:fs stub (no root, no real disk full).

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'advisers-fs-safe-'))
}

/**
 * Fake fs for fsyncFileSync path tests: records `openSync` flags and plays a
 * scripted result per flags value ({ fd } or { error }). No real disk involved.
 */
function stubFsyncFs(behaviour) {
  const opens = []
  const fsyncs = []
  const closes = []
  const fs = {
    openSync: (file, flags) => {
      opens.push(flags)
      const result = behaviour[flags]
      if (!result) throw new Error(`stubFsyncFs: unexpected open flags "${flags}"`)
      if (result.error) throw result.error
      return result.fd
    },
    fsyncSync: (fd) => { fsyncs.push(fd) },
    closeSync: (fd) => { closes.push(fd) },
  }
  return { fs, opens, fsyncs, closes }
}

function errnoError(code) {
  const error = new Error(`${code}: operation not permitted, open`)
  error.code = code
  return error
}

function makeShortWriteFs(chunk = 777) {
  const stub = {
    calls: 0,
    ...realFs,
    writeSync: (fd, buffer, offset, length) => {
      stub.calls += 1
      return realFs.writeSync(fd, buffer, offset, Math.min(length, chunk))
    },
  }
  return stub
}

test('fs-safe: writeAllSync loops over short writes until every byte is written', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'out.bin')
    const data = Buffer.alloc(10_000, 0x5a)
    const fd = realFs.openSync(file, 'w')
    const shortWrite = makeShortWriteFs()
    try {
      assert.equal(writeAllSync(fd, data, { fs: shortWrite }), data.length)
    } finally { realFs.closeSync(fd) }
    assert.ok(shortWrite.calls > 1, 'the stub must produce multiple short writes')
    assert.deepEqual(readFileSync(file), data)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: writeAllSync treats zero/negative progress as E_SHORT_WRITE instead of success', () => {
  assert.throws(() => writeAllSync(3, Buffer.alloc(10), { fs: { writeSync: () => 0 } }), (error) => error.code === 'E_SHORT_WRITE' && error.written === 0)
  assert.throws(() => writeAllSync(3, Buffer.alloc(10), { fs: { writeSync: () => -1 } }), (error) => error.code === 'E_SHORT_WRITE')
})

test('fs-safe: atomicWriteFileSync installs the complete file despite short writes', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'state.db.vault')
    const data = Buffer.alloc(20_000, 0x41)
    atomicWriteFileSync(file, data, { fs: makeShortWriteFs(), retries: 0 })
    assert.equal(statSync(file).size, data.length)
    assert.deepEqual(readFileSync(file), data)
    assert.deepEqual(readdirSync(dir), ['state.db.vault'], 'no temp file may remain')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: ENOSPC mid-write removes the temp file, keeps the target absent and throws ENOSPC', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'state.db.vault')
    let calls = 0
    const enospcFs = {
      ...realFs,
      writeSync: (fd, buffer, offset, length) => {
        calls += 1
        if (calls > 1) {
          const error = new Error('ENOSPC: no space left on device, write')
          error.code = 'ENOSPC'
          throw error
        }
        return realFs.writeSync(fd, buffer, offset, Math.min(length, 32))
      },
    }
    assert.throws(() => atomicWriteFileSync(file, Buffer.alloc(4096), { fs: enospcFs, retries: 0 }), (error) => error.code === 'ENOSPC')
    assert.equal(existsSync(file), false, 'a failed write must not install a truncated target')
    assert.deepEqual(readdirSync(dir), [], 'the temp file must be removed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: a lying writeSync that claims success with a short file fails the length check and cleans up', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'pet-brief.json')
    // Returns the requested length but physically writes only half: exactly what
    // a filesystem with a silently truncated write would look like.
    const lyingFs = {
      ...realFs,
      writeSync: (fd, buffer, offset, length) => {
        realFs.writeSync(fd, buffer, offset, Math.floor(length / 2))
        return length
      },
    }
    assert.throws(
      () => writeAllToTempSync(file, Buffer.alloc(1000), { fs: lyingFs, retries: 0 }),
      (error) => error.code === 'E_SHORT_WRITE' || /E_SHORT_WRITE/.test(String(error.message)),
    )
    assert.equal(existsSync(file), false)
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: rename retries a transient EPERM/EBUSY and then succeeds', () => {
  const dir = makeDir()
  try {
    const target = join(dir, 'out.bin')
    let renameCalls = 0
    const flakyFs = {
      ...realFs,
      renameSync: (from, to) => {
        renameCalls += 1
        if (renameCalls === 1) {
          const error = new Error('EPERM: operation not permitted, rename')
          error.code = 'EPERM'
          throw error
        }
        return realFs.renameSync(from, to)
      },
    }
    atomicWriteFileSync(target, 'durable payload', { fs: flakyFs, retries: 3, sleep: () => {} })
    assert.equal(renameCalls, 2)
    assert.equal(readFileSync(target, 'utf8'), 'durable payload')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: retryFsSync retries only the configured transient errnos and gives up after the limit', () => {
  let permanent = 0
  assert.throws(
    () => retryFsSync(() => { permanent += 1; const error = new Error('ENOSPC'); error.code = 'ENOSPC'; throw error }, { retries: 5, sleep: () => {} }),
    /ENOSPC/,
  )
  assert.equal(permanent, 1, 'ENOSPC is not retryable')
  let calls = 0
  assert.throws(
    () => retryFsSync(() => { calls += 1; const error = new Error('EBUSY: resource busy'); error.code = 'EBUSY'; throw error }, { retries: 2, sleep: () => {} }),
    /EBUSY/,
  )
  assert.equal(calls, 3, 'one initial attempt plus two retries')
})

test('fs-safe: commitTempFileSync cleans the temp file when the rename fails', () => {
  const dir = makeDir()
  try {
    const tmp = join(dir, '.out.tmp-test')
    writeFileSync(tmp, 'data')
    const failingFs = {
      ...realFs,
      renameSync: () => { const error = new Error('EIO: i/o error, rename'); error.code = 'EIO'; throw error },
    }
    assert.throws(() => commitTempFileSync(tmp, join(dir, 'out'), { fs: failingFs, retries: 0 }), /EIO/)
    assert.equal(existsSync(tmp), false, 'temp must not survive a failed commit')
    assert.equal(existsSync(join(dir, 'out')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: an explicit tempPath collision fails without deleting the pre-existing file', () => {
  const dir = makeDir()
  try {
    const target = join(dir, 'out.bin')
    const occupied = join(dir, '.out.bin.tmp-occupied')
    writeFileSync(occupied, 'someone else\'s temp file')
    assert.throws(() => writeAllToTempSync(target, Buffer.from('mine'), { tempPath: occupied }), (error) => error.code === 'EEXIST')
    assert.equal(readFileSync(occupied, 'utf8'), 'someone else\'s temp file', 'the foreign temp file must be left untouched')
    assert.equal(existsSync(target), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: copy/rm helpers retry transient errors and tolerate a missing rm target', () => {
  const dir = makeDir()
  try {
    const source = join(dir, 'source.bin')
    const target = join(dir, 'target.bin')
    writeFileSync(source, Buffer.alloc(1024, 1))
    let copyCalls = 0
    const flakyFs = {
      ...realFs,
      copyFileSync: (from, to) => {
        copyCalls += 1
        if (copyCalls === 1) { const error = new Error('EBUSY: resource busy'); error.code = 'EBUSY'; throw error }
        return realFs.copyFileSync(from, to)
      },
    }
    copyFileWithRetrySync(source, target, { fs: flakyFs, sleep: () => {} })
    assert.equal(copyCalls, 2)
    assert.equal(statSync(target).size, 1024)
    assertPrivateMode(target, 0o600, 'backups are private')
    assert.equal(rmWithRetrySync(join(dir, 'missing.bin'), { fs: realFs }), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: temp naming is hidden, same-directory and discoverable by its prefix', () => {
  // Platform-independent absolute path: a hardcoded POSIX path compares the
  // POSIX dirname on Linux but a "\\home\\user\\.advisers" dirname on Windows
  // (synthetic Windows root). The contract is "temp lives in the target's
  // directory", so assert that instead of a literal path.
  const file = join(tmpdir(), 'adv-home', 'user', '.advisers', 'state.db.vault')
  const tmp = tempPathForSync(file)
  assert.equal(dirname(tmp), dirname(file), 'rename must stay on the same filesystem')
  assert.ok(basename(tmp).startsWith('.state.db.vault.tmp-'), `unexpected temp name ${tmp}`)
  assert.ok(tmp.startsWith(tempPrefixForSync(file)))
})

test('fs-safe: describeFsError maps disk-full and permission failures to actionable text', () => {
  const noSpace = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  const denied = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
  assert.match(describeFsError(noSpace, { action: 'sealing', path: 'state.db.vault' }), /E_NO_SPACE.*disk space.*state\.db\.vault.*no truncated file/)
  assert.match(describeFsError(denied, { action: 'renaming', target: 'state.db.vault' }), /E_FS_PERMISSION.*denied.*permissions/)
})

test('fs-safe: fsyncFileSync(path) opens a writable non-truncating handle and leaves bytes/length unchanged', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'import-backup.db')
    const payload = Buffer.alloc(4096, 0x5a)
    writeFileSync(file, payload)
    const sizeBefore = statSync(file).size
    const flags = []
    const recordingFs = {
      ...realFs,
      openSync: (path, flag, mode) => { flags.push(flag); return realFs.openSync(path, flag, mode) },
    }
    fsyncFileSync(file, { fs: recordingFs, retries: 0 })
    assert.deepEqual(flags, ['r+'], 'fsync must open writable but non-truncating (r+), never r/w/w+')
    assert.deepEqual(readFileSync(file), payload, 'fsync must not change the file bytes')
    assert.equal(statSync(file).size, sizeBefore, 'fsync must not change the file length')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: Windows never fsyncs a read-only handle (fail-closed, classified E_FS_PERMISSION)', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const { fs, opens, fsyncs } = stubFsyncFs({ 'r+': { error: errnoError(code) }, r: { fd: 9 } })
    let thrown = null
    try {
      fsyncFileSync('/data/import-backup.db', { fs, platform: 'win32', retries: 0, sleep: () => {} })
    } catch (error) { thrown = error }
    assert.ok(thrown, code + ': a read-only file on Windows must fail, not silently skip the flush')
    assert.equal(thrown.code, code, 'the original errno is preserved for callers/describeFsError')
    assert.match(thrown.message, /windows/i)
    assert.match(thrown.message, /writable handle/i)
    assert.deepEqual(opens, ['r+'], code + ': the read-only fallback must NOT be attempted on Windows')
    assert.deepEqual(fsyncs, [], code + ': no fsync may be attempted on a handle Windows would reject')
    assert.match(describeFsError(thrown, { action: 'copying the database to', target: '/data/import-backup.db' }), /E_FS_PERMISSION/)
  }
})

test('fs-safe: POSIX keeps the read-only fallback (fsync(2) accepts an O_RDONLY descriptor)', () => {
  const { fs, opens, fsyncs, closes } = stubFsyncFs({ 'r+': { error: errnoError('EACCES') }, r: { fd: 9 } })
  fsyncFileSync('/data/read-only.db', { fs, platform: 'linux', retries: 0, sleep: () => {} })
  assert.deepEqual(opens, ['r+', 'r'])
  assert.deepEqual(fsyncs, [9])
  assert.deepEqual(closes, [9])
})

test('fs-safe: fsyncFileSync(path) never creates a missing file unless createIfMissing is set', () => {
  const dir = makeDir()
  try {
    const missing = join(dir, 'not-written-yet.db')
    let thrown = null
    try { fsyncFileSync(missing, { retries: 0, sleep: () => {} }) } catch (error) { thrown = error }
    assert.equal(thrown && thrown.code, 'ENOENT')
    assert.equal(existsSync(missing), false, 'fsync must not create a file the caller never wrote')
    fsyncFileSync(missing, { createIfMissing: true, retries: 0 })
    assert.equal(existsSync(missing), true)
    assert.equal(statSync(missing).size, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: fsyncFileSync(fd) flushes the caller-owned writable descriptor', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'wal-copy')
    const fd = realFs.openSync(file, 'w')
    try {
      realFs.writeSync(fd, Buffer.from('durable'))
      fsyncFileSync(fd, { retries: 0 })
    } finally { realFs.closeSync(fd) }
    assert.equal(readFileSync(file, 'utf8'), 'durable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: backup/import copy+fsync leaves the copy byte-identical (the bin contract)', () => {
  const dir = makeDir()
  try {
    const source = join(dir, 'state.db')
    const backup = join(dir, 'backup.db')
    const payload = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.alloc(2048, 7)])
    writeFileSync(source, payload)
    copyFileWithRetrySync(source, backup)
    const before = readFileSync(backup)
    fsyncFileSync(backup, { retries: 0 }) // the exact step bin/backup and import --replace use
    assert.deepEqual(readFileSync(backup), before)
    assert.equal(statSync(backup).size, before.length)
    assertPrivateMode(backup, 0o600, 'backups stay private')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fs-safe: fsyncDirSync is best-effort (returns a boolean, never throws)', () => {
  assert.equal(typeof fsyncDirSync(tmpdir()), 'boolean')
  const failingFs = { ...realFs, openSync: () => { const error = new Error('EPERM: operation not permitted, open'); error.code = 'EPERM'; throw error } }
  assert.equal(fsyncDirSync('/definitely/not/a/dir', { fs: failingFs }), false)
  // Windows cannot fsync a directory (and cannot open one read-write): report
  // false without attempting the read-only open that used to EPERM.
  let opened = 0
  const neverOpen = { openSync: () => { opened += 1; throw new Error('must not open a directory handle on Windows') } }
  assert.equal(fsyncDirSync('/definitely/not/a/dir', { fs: neverOpen, platform: 'win32' }), false)
  assert.equal(opened, 0)
})

test('fs-safe: stale 0600 temp files can be discovered by the exported prefix for cleanup', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'state.db.vault')
    const stale = tempPathForSync(file)
    writeFileSync(stale, 'partial')
    utimesSync(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    const prefix = basename(tempPrefixForSync(file))
    assert.ok(readdirSync(dir).some((name) => name.startsWith(prefix)), 'cleanup scan can find it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
