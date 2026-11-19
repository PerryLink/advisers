/**
 * BOM-aware text/JSON file helpers (0.3.0 output kernel).
 *
 * Windows PowerShell 5.1 is a first-class environment for Advisers and it writes
 * BOMs: `Out-File -Encoding utf8` emits EF BB BF, `>` / `>>` redirection emits a
 * UTF-16LE BOM (FF FE). Node then reads the BOM as a character and JSON.parse fails.
 * These helpers detect and remove the BOM at the read boundary (parsing only; the
 * original bytes and their hashes are never rewritten), and write UTF-8 without a BOM
 * atomically through lib/fs-safe.js.
 *
 * This module does not decide which inputs are user-editable; the Wave-2 CLI wiring
 * routes import/template/state/office-edit reads through it.
 */
import { readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../fs-safe.js'
import { stripBom } from '../text-safe.js'
import { stringifyJson } from './json.js'

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

/**
 * Decode a buffer into text, removing a leading BOM and decoding UTF-16 when the BOM
 * says so (PowerShell 5.1 redirection). Unknown input is decoded as UTF-8.
 *
 * @param {Buffer | Uint8Array | string} buffer
 * @returns {string}
 */
export function decodeTextBuffer(buffer) {
  if (typeof buffer === 'string') return stripBom(buffer)
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    return stripBom(bytes.subarray(3).toString('utf8'))
  }
  if (bytes.length >= 2 && bytes[0] === UTF16LE_BOM[0] && bytes[1] === UTF16LE_BOM[1]) {
    return stripBom(bytes.subarray(2).toString('utf16le'))
  }
  if (bytes.length >= 2 && bytes[0] === UTF16BE_BOM[0] && bytes[1] === UTF16BE_BOM[1]) {
    const body = Buffer.from(bytes.subarray(2))
    if (body.length % 2 !== 0) body.writeUInt8(0, body.length - 1)
    body.swap16()
    return stripBom(body.toString('utf16le'))
  }
  return stripBom(bytes.toString('utf8'))
}

/**
 * True when the leading bytes are a BOM this module understands.
 *
 * @param {Buffer | Uint8Array} buffer
 * @returns {boolean}
 */
export function hasTextBom(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) return true
  if (bytes.length >= 2 && bytes[0] === UTF16LE_BOM[0] && bytes[1] === UTF16LE_BOM[1]) return true
  if (bytes.length >= 2 && bytes[0] === UTF16BE_BOM[0] && bytes[1] === UTF16BE_BOM[1]) return true
  return false
}

/**
 * Read a text file as UTF-8, stripping a UTF-8/UTF-16 BOM if present.
 *
 * @param {string} file
 * @returns {string}
 */
export function readTextFile(file) {
  return decodeTextBuffer(readFileSync(file))
}

/**
 * Read and parse a JSON file, tolerating a Windows BOM.
 *
 * @param {string} file
 * @returns {unknown}
 */
export function readJsonFile(file) {
  const text = readTextFile(file)
  try {
    return JSON.parse(text)
  } catch (error) {
    const wrapped = new SyntaxError(`invalid JSON in ${file}: ${error.message}`)
    wrapped.name = 'JsonFileError'
    wrapped.code = 'E_JSON_INVALID'
    wrapped.cause = error
    throw wrapped
  }
}

/**
 * Write UTF-8 text without a BOM, atomically and durably (0600 by default).
 *
 * @param {string} file
 * @param {string} text
 * @param {{ mode?: number, fsync?: boolean }} [options]
 * @returns {number} bytes written
 */
export function writeTextFile(file, text, { mode = 0o600, fsync = true } = {}) {
  const data = Buffer.from(String(text), 'utf8')
  atomicWriteFileSync(file, data, { mode, fsync })
  return data.length
}

/**
 * Serialise a value as JSON and write it as UTF-8 without a BOM (atomic, durable).
 *
 * @param {string} file
 * @param {unknown} value
 * @param {{ space?: number, sanitize?: boolean, mode?: number, fsync?: boolean }} [options]
 * @returns {number} bytes written
 */
export function writeJsonFile(file, value, { space = 0, sanitize = false, mode = 0o600, fsync = true } = {}) {
  return writeTextFile(file, stringifyJson(value, { space, sanitize }), { mode, fsync })
}

