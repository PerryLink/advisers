import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  advisersHome, hasImapCredential, imapCredentialPath, imapCredentialsDir,
  listImapCredentialAccountIds, readImapCredential, removeImapCredential, saveImapCredential,
} from '../lib/credentials.js'
import { mailAccountAdd, mailAccountList, mailAccountRemove } from '../lib/mail.js'
import { openMailStore } from './mail-fixture.js'

const POSIX = process.platform !== 'win32'
const SECRET = 'app-password-secret'

function readDbBytes(dbPath) {
  const parts = []
  for (const file of [dbPath, dbPath + '-wal']) {
    try { parts.push(readFileSync(file)) } catch {}
  }
  return Buffer.concat(parts)
}

test('credentials: atomic 0600 file in a 0700 directory, read/remove round-trip', () => {
  const { root, home, cleanup } = openMailStore()
  try {
    const saved = saveImapCredential('acct_test_1', { user: 'me@example.com', pass: SECRET }, { home })
    assert.equal(saved.accountId, 'acct_test_1')
    assert.equal(saved.user, 'me@example.com')
    assert.equal('pass' in saved, false, 'save metadata never contains the password')
    const file = imapCredentialPath('acct_test_1', { home })
    assert.equal(saved.path, file)
    assert.ok(existsSync(file))
    assert.deepEqual(readdirSync(imapCredentialsDir(home)), ['acct_test_1.json'], 'no temp file is left behind')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.format, 1)
    assert.equal(record.accountId, 'acct_test_1')
    assert.equal(record.pass, SECRET)
    if (POSIX) {
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(statSync(imapCredentialsDir(home)).mode & 0o777, 0o700)
    }
    assert.deepEqual(readImapCredential('acct_test_1', { home }), {
      accountId: 'acct_test_1', user: 'me@example.com', pass: SECRET, updatedAt: saved.updatedAt,
    })
    assert.equal(hasImapCredential('acct_test_1', { home }), true)
    assert.deepEqual(listImapCredentialAccountIds({ home }), ['acct_test_1'])
    assert.equal(removeImapCredential('acct_test_1', { home }), true)
    assert.equal(removeImapCredential('acct_test_1', { home }), false)
    assert.equal(readImapCredential('acct_test_1', { home }), undefined)
  } finally { cleanup() }
})

test('credentials: loose permissions, symlinks, corrupt JSON and path traversal are refused', () => {
  const { home, cleanup } = openMailStore()
  try {
    saveImapCredential('acct_test_2', { user: 'me@example.com', pass: SECRET }, { home })
    const file = imapCredentialPath('acct_test_2', { home })
    if (POSIX) {
      chmodSync(file, 0o644)
      assert.throws(() => readImapCredential('acct_test_2', { home }), (error) => error.code === 'E_CREDENTIALS_INSECURE')
      chmodSync(file, 0o600)
    }
    const target = join(home, 'target.json')
    writeFileSync(target, JSON.stringify({ format: 1, accountId: 'acct_link', user: 'u', pass: 'p' }))
    const link = imapCredentialPath('acct_link', { home })
    try { symlinkSync(target, link) } catch { /* Windows without developer mode */ }
    if (existsSync(link)) {
      assert.throws(() => readImapCredential('acct_link', { home }), (error) => error.code === 'E_CREDENTIALS_INSECURE')
    }
    writeFileSync(file, '{not json')
    assert.throws(() => readImapCredential('acct_test_2', { home }), (error) => error.code === 'E_CREDENTIALS_INSECURE')
    assert.throws(() => saveImapCredential('../escape', { user: 'u', pass: 'p' }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => saveImapCredential('bad/id', { user: 'u', pass: 'p' }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => saveImapCredential('acct_ok', { user: 'u', pass: '' }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => saveImapCredential('acct_ok', { user: 'u', pass: 'p' }, { home: 42 }), (error) => error.code === 'E_MAIL_CONFIG')
  } finally { cleanup() }
})

test('account add stores the credential outside the ledger and never logs the password', () => {
  const { root, home, store, cleanup } = openMailStore()
  try {
    const logs = []
    const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info }
    for (const key of Object.keys(originals)) console[key] = (...args) => logs.push([key, ...args])
    let account
    try {
      account = mailAccountAdd(store, {
        name: 'work', host: 'imap.example.com', port: 993, tls: 'tls', username: 'me@example.com',
        pass: SECRET, // deliberately NOT read by mailAccountAdd; only options.credential is
      }, { home, credential: { pass: SECRET } }).account
    } finally {
      Object.assign(console, originals)
    }
    assert.equal(account.hasCredential, true)
    assert.equal(logs.length, 0, 'account add must not write to the console')
    const list = mailAccountList(store, { home })
    assert.equal(list.total, 1)
    assert.equal(list.accounts[0].hasCredential, true)
    assert.equal(JSON.stringify(list).includes(SECRET), false, 'account JSON never carries the password')
    assert.equal(readDbBytes(join(root, 'state.db')).includes(Buffer.from(SECRET)), false, 'the password is not in the SQLite ledger or its WAL')
    assert.ok(existsSync(imapCredentialPath(account.id, { home })))
    assert.throws(() => mailAccountAdd(store, { name: 'work', host: 'imap.example.com', tls: 'tls', username: 'second@example.com' }, { home, credential: { pass: 'x' } }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.equal(readImapCredential(account.id, { home }).pass, SECRET, 'a rejected duplicate must not touch the existing credential')
  } finally { cleanup() }
})

test('account remove deletes the credential file and tombstones the account', () => {
  const { home, store, cleanup } = openMailStore()
  try {
    const account = mailAccountAdd(store, {
      name: 'work', host: 'imap.example.com', tls: 'tls', username: 'me@example.com',
    }, { home, credential: { pass: SECRET } }).account
    const result = mailAccountRemove(store, account.id, { home })
    assert.equal(result.removed, true)
    assert.equal(result.credentialRemoved, true)
    assert.equal(existsSync(imapCredentialPath(account.id, { home })), false)
    assert.equal(mailAccountList(store, { home }).total, 0)
    assert.equal(mailAccountList(store, { home, includeRemoved: true }).total, 1)
  } finally { cleanup() }
})

test('cleartext transports and secure=0 are rejected at account creation', () => {
  const { home, store, cleanup } = openMailStore()
  try {
    const base = { name: 'x', host: 'imap.example.com', username: 'u@example.com' }
    assert.throws(() => mailAccountAdd(store, { ...base, tls: 'none' }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => mailAccountAdd(store, { ...base, secure: false }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => mailAccountAdd(store, { ...base, secure: 0 }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => mailAccountAdd(store, { ...base, tls: 'starttls', port: 0 }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => mailAccountAdd(store, { ...base, retentionDays: -1 }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
    assert.throws(() => mailAccountAdd(store, { ...base, name: '   ' }, { home }), (error) => error.code === 'E_MAIL_CONFIG')
  } finally { cleanup() }
})

test('advisersHome honours the explicit argument, ADVISERS_HOME and ~/.advisers in that order', () => {
  const previous = process.env.ADVISERS_HOME
  try {
    process.env.ADVISERS_HOME = '/tmp/explicit-home-from-env'
    assert.equal(advisersHome('/tmp/given'), '/tmp/given')
    assert.equal(advisersHome(), '/tmp/explicit-home-from-env')
    delete process.env.ADVISERS_HOME
    assert.match(advisersHome(), /[\\/]\.advisers$/)
  } finally {
    if (previous === undefined) delete process.env.ADVISERS_HOME
    else process.env.ADVISERS_HOME = previous
  }
})
