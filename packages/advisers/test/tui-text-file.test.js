import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  decodeTextBuffer,
  hasTextBom,
  readJsonFile,
  readTextFile,
  writeJsonFile,
  writeTextFile,
} from '../lib/tui/text-file.js'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-tui-file-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('decodeTextBuffer handles UTF-8, UTF-8 BOM, UTF-16LE/BE BOM', () => {
  const text = '{"ok":true,"name":"王工"}'
  assert.equal(decodeTextBuffer(Buffer.from(text, 'utf8')), text)
  assert.equal(decodeTextBuffer(Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])), text)
  assert.equal(decodeTextBuffer(Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')])), text)
  const beBody = Buffer.from(text, 'utf16le')
  beBody.swap16()
  assert.equal(decodeTextBuffer(Buffer.concat([UTF16BE_BOM, beBody])), text)
  assert.equal(decodeTextBuffer('\uFEFFhello'), 'hello')
  assert.equal(decodeTextBuffer(Buffer.alloc(0)), '')
})

test('hasTextBom detects all supported BOMs', () => {
  assert.equal(hasTextBom(UTF8_BOM), true)
  assert.equal(hasTextBom(UTF16LE_BOM), true)
  assert.equal(hasTextBom(UTF16BE_BOM), true)
  assert.equal(hasTextBom(Buffer.from('{"a":1}', 'utf8')), false)
  assert.equal(hasTextBom(Buffer.alloc(0)), false)
})

test('readTextFile reads a Windows PowerShell BOM file', () => withTempDir((root) => {
  const file = join(root, 'ps5-out.json')
  writeFileSync(file, Buffer.concat([UTF8_BOM, Buffer.from('{"ok":true,"名字":"王工"}', 'utf8')]))
  assert.equal(readTextFile(file), '{"ok":true,"名字":"王工"}')
  assert.equal(hasTextBom(readFileSync(file)), true)
}))

test('readJsonFile tolerates UTF-8 and UTF-16 BOMs (M10 Windows gate)', () => withTempDir((root) => {
  const payload = { ok: true, name: '王工', count: 2 }
  const asText = JSON.stringify(payload)
  const utf8Bom = join(root, 'utf8-bom.json')
  const utf16le = join(root, 'utf16le.json')
  const utf16be = join(root, 'utf16be.json')
  writeFileSync(utf8Bom, Buffer.concat([UTF8_BOM, Buffer.from(asText, 'utf8')]))
  writeFileSync(utf16le, Buffer.concat([UTF16LE_BOM, Buffer.from(asText, 'utf16le')]))
  const beBody = Buffer.from(asText, 'utf16le')
  beBody.swap16()
  writeFileSync(utf16be, Buffer.concat([UTF16BE_BOM, beBody]))
  assert.deepEqual(readJsonFile(utf8Bom), payload)
  assert.deepEqual(readJsonFile(utf16le), payload)
  assert.deepEqual(readJsonFile(utf16be), payload)
}))

test('readJsonFile reports a stable error for malformed JSON', () => withTempDir((root) => {
  const file = join(root, 'bad.json')
  writeFileSync(file, '{oops')
  assert.throws(() => readJsonFile(file), (error) => {
    assert.equal(error.name, 'JsonFileError')
    assert.equal(error.code, 'E_JSON_INVALID')
    assert.ok(error.message.includes(file), 'message names the file')
    assert.ok(error.cause instanceof SyntaxError)
    return true
  })
  assert.throws(() => readJsonFile(join(root, 'missing.json')), /ENOENT/)
}))

test('writeTextFile writes UTF-8 without a BOM', () => withTempDir((root) => {
  const file = join(root, 'out.txt')
  const bytes = writeTextFile(file, '中文 text')
  const data = readFileSync(file)
  assert.equal(bytes, data.length)
  assert.notDeepEqual(data.subarray(0, 3), UTF8_BOM)
  assert.equal(data.toString('utf8'), '中文 text')
}))

test('writeJsonFile writes BOM-less UTF-8, atomically, with 0600 default', () => withTempDir((root) => {
  const file = join(root, 'out.json')
  const payload = { ok: true, name: '王工', nested: { value: 1 } }
  writeTextFile(file, 'stale content that must be replaced')
  const bytes = writeJsonFile(file, payload, { space: 0 })
  const data = readFileSync(file)
  assert.equal(bytes, data.length)
  assert.equal(data[0], 0x7b, 'first byte is { (no BOM)')
  assert.notDeepEqual(data.subarray(0, 3), UTF8_BOM)
  assert.deepEqual(JSON.parse(data.toString('utf8')), payload)
  assert.deepEqual(readJsonFile(file), payload)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
}))

test('writeJsonFile can sanitise display fields when asked', () => withTempDir((root) => {
  const file = join(root, 'safe.json')
  const ESC = '\u001b'
  writeJsonFile(file, { message: ESC + '[2Jbad' }, { sanitize: true })
  assert.deepEqual(readJsonFile(file), { message: 'bad' })
}))

