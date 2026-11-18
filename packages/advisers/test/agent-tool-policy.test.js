import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  executeTool,
  normalizePolicyPath,
  resolveToolPath,
  sensitivePathReason,
} from '../lib/agent.js'

const SENSITIVE_READS = [
  '.ssh/id_ed25519',
  '.ssh/authorized_keys',
  '.aws/credentials',
  '.netrc',
  '.gnupg/private-keys-v1.d/key.key',
  '.config/gh/hosts.yml',
  '.config/gcloud/credentials.db',
  '.kube/config',
  '.docker/config.json',
  '.advisers/audit.key',
  '.advisers/state.json',
  '.advisers/state.db.before-migrate-v18-2026',
  '.advisers/snapshot.vault',
  '.mozilla/firefox/profile/logins.json',
  'Library/Application Support/Google/Chrome/Default/Login Data',
  'credentials',
  'server.pem',
  'id_rsa',
]

const PERSISTENCE_WRITES = [
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  'authorized_keys',
  '.config/autostart/evil.desktop',
  '.config/systemd/user/evil.service',
  'crontab',
]

test('file tools default to the workspace root and reject escapes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  try {
    await executeTool('file_write', { path: 'out/a.txt', content: 'hello' }, { cwd })
    assert.equal((await executeTool('file_read', { path: 'out/a.txt' }, { cwd })).content, 'hello')
    await assert.rejects(() => executeTool('file_read', { path: '../outside.txt' }, { cwd }), (error) => {
      assert.match(error.message, /escapes workspace/)
      assert.equal(error.code, 'OUTSIDE_WORKSPACE')
      return true
    })
    await assert.rejects(() => executeTool('file_write', { path: '../outside.txt', content: 'x' }, { cwd }), /escapes workspace/)
    await assert.rejects(() => executeTool('file_read', { path: '/etc/shadow' }, { cwd }), /escapes workspace/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('sensitive credential paths are denied even inside the workspace', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  try {
    for (const path of SENSITIVE_READS) {
      await assert.rejects(() => executeTool('file_read', { path }, { cwd }), (error) => {
        assert.match(error.message, /protected/, path)
        assert.equal(error.code, 'SENSITIVE_PATH', path)
        return true
      })
    }
    assert.ok(SENSITIVE_READS.length >= 12)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a home directory as the workspace still denies credential stores', async () => {
  const home = mkdtempSync(join(tmpdir(), 'adv023-home-'))
  try {
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(home, '.advisers'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    writeFileSync(join(home, '.advisers', 'audit.key'), 'hmac')
    await assert.rejects(() => executeTool('file_read', { path: '.ssh/id_ed25519' }, { cwd: home }), /protected/)
    await assert.rejects(() => executeTool('file_read', { path: '.advisers/audit.key' }, { cwd: home }), /protected/)
    await assert.rejects(() => executeTool('file_write', { path: '.bashrc', content: 'export X=1' }, { cwd: home }), /protected/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('persistence targets are write-denied (read-only listing is not the point)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  try {
    for (const path of PERSISTENCE_WRITES) {
      await assert.rejects(() => executeTool('file_write', { path, content: 'x' }, { cwd }), (error) => {
        assert.match(error.message, /protected/, path)
        assert.ok(error.code === 'PERSISTENCE_WRITE' || error.code === 'SENSITIVE_PATH', path + ' ' + error.code)
        return true
      })
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('symlinks cannot escape the workspace', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  const outside = mkdtempSync(join(tmpdir(), 'adv023-outside-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'worker-secret')
    symlinkSync(outside, join(cwd, 'linkdir'))
    symlinkSync(join(outside, 'secret.txt'), join(cwd, 'linkfile.txt'))
    writeFileSync(join(cwd, 'real.txt'), 'inside')
    symlinkSync(join(cwd, 'real.txt'), join(cwd, 'inside-link.txt'))
    await assert.rejects(() => executeTool('file_write', { path: 'linkdir/pwn.txt', content: 'x' }, { cwd }), /symlink/)
    await assert.rejects(() => executeTool('file_read', { path: 'linkfile.txt' }, { cwd }), /symlink/)
    await assert.rejects(() => executeTool('file_write', { path: 'inside-link.txt', content: 'x' }, { cwd }), /symlink/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('the explicit allow list widens the workspace but never the sensitive list', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  const outside = mkdtempSync(join(tmpdir(), 'adv023-outside-'))
  try {
    writeFileSync(join(outside, 'ok.txt'), 'outside-data')
    await assert.rejects(() => executeTool('file_read', { path: join(outside, 'ok.txt') }, { cwd }), /escapes workspace/)
    const read = await executeTool('file_read', { path: join(outside, 'ok.txt') }, { cwd, allowPaths: [outside] })
    assert.equal(read.content, 'outside-data')
    const written = await executeTool('file_write', { path: join(outside, 'new.txt'), content: 'ok' }, { cwd, allowPaths: [outside] })
    assert.equal(written.ok, true)
    await assert.rejects(() => executeTool('file_read', { path: join(outside, '.ssh', 'id_rsa') }, { cwd, allowPaths: [outside] }), /protected/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('workspaceRoot can be wider than cwd but the cwd must stay inside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  const outside = mkdtempSync(join(tmpdir(), 'adv023-outside-'))
  try {
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sibling.txt'), 'sibling')
    const cwd = join(root, 'sub')
    const read = await executeTool('file_read', { path: '../sibling.txt' }, { cwd, workspaceRoot: root })
    assert.equal(read.content, 'sibling')
    await assert.rejects(() => executeTool('file_read', { path: join(outside, 'x.txt') }, { cwd, workspaceRoot: root }), /escapes workspace/)
    await assert.rejects(() => executeTool('file_read', { path: 'a.txt' }, { cwd: outside, workspaceRoot: root }), /outside the workspace root/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('onToolAction audits allowed and denied actions without breaking tools', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  try {
    const events = []
    const onToolAction = async (entry) => { await Promise.resolve(); events.push(entry) }
    await executeTool('file_write', { path: 'ok.txt', content: 'x' }, { cwd, onToolAction, turnId: 't1' })
    await assert.rejects(() => executeTool('file_read', { path: '.ssh/id_ed25519' }, { cwd, onToolAction, turnId: 't1' }), /protected/)
    const allowed = events.find((entry) => entry.allowed === true)
    assert.ok(allowed)
    assert.equal(allowed.tool, 'file_write')
    assert.equal(allowed.action, 'write')
    assert.equal(allowed.relativePath, 'ok.txt')
    assert.equal(allowed.turnId, 't1')
    const denied = events.find((entry) => entry.allowed === false)
    assert.ok(denied)
    assert.equal(denied.tool, 'file_read')
    assert.equal(denied.code, 'SENSITIVE_PATH')
    assert.match(denied.reason, /protected/)
    assert.equal(denied.turnId, 't1')
    // A throwing hook must never break the tool call itself.
    const written = await executeTool('file_write', { path: 'throwing.txt', content: 'x' }, {
      cwd,
      onToolAction: () => { throw new Error('audit down') },
    })
    assert.equal(written.ok, true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('office tool output paths go through the same boundary', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  try {
    await assert.rejects(() => executeTool('office_build', {
      kind: 'docx',
      out: '../escape.docx',
      spec: { title: 'x', sections: [] },
    }, { cwd }), /escapes workspace/)
    await assert.rejects(() => executeTool('office_template', {
      name: 'weekly',
      out: '.bashrc',
      data: { period: 'W1', done: ['x'] },
    }, { cwd }), /protected/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('policy path normalization handles Windows-style credential samples', () => {
  assert.deepEqual(normalizePolicyPath('C:\\Users\\alice\\.SSH.\\id_rsa').segments, ['c:', 'users', 'alice', '.ssh', 'id_rsa'])
  assert.equal(sensitivePathReason('C:\\Users\\alice\\.SSH.\\id_rsa').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('C:\\Users\\alice\\.config\\gh\\hosts.yml').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('C:\\Users\\alice\\.advisers\\state.db.before-migrate-v18-2026').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('C:\\Users\\alice\\Documents\\report.docx'), null)
  assert.equal(sensitivePathReason('/etc/shadow').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('/etc/sudoers.d/evil').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('/home/u/.ssh/id_rsa').code, 'SENSITIVE_PATH')
  assert.equal(sensitivePathReason('/home/u/notes.txt'), null)
})

test('resolveToolPath returns the canonical real path inside the root', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv023-policy-'))
  try {
    writeFileSync(join(cwd, 'a.txt'), 'x')
    const resolved = resolveToolPath('a.txt', { cwd, action: 'read' })
    assert.equal(resolved, join(cwd, 'a.txt'))
    assert.throws(() => resolveToolPath('', { cwd }), /path is required/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
