/**
 * E7-T3: local OCR adapter.
 *
 * Advisers does not bundle an OCR engine and never calls a cloud OCR service.
 * The user may point `ADVISERS_OCR_CMD` at a local executable (e.g. tesseract),
 * which receives the image path as its only argument and writes text to stdout.
 * If unset, OCR is explicitly unavailable (fail closed) — scanned files are not
 * silently treated as empty/valid text.
 */
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { resolve, isAbsolute, relative } from 'node:path'

/**
 * Environment for the adapter subprocess: an explicit allowlist.
 *
 * The adapter is a local third-party program (e.g. an OCR engine). Inheriting
 * process.env would hand it every Advisers secret — ADVISERS_API_KEY,
 * ADVISERS_AUDIT_KEY (the audit HMAC key), vault/sync/export passphrases and
 * provider URLs (security audit SEC2-03, 2026-11-17). Only OS/runtime basics
 * needed to start a program are passed through; credentials never are.
 */
const ADAPTER_ENV_KEYS = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'windir',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'PSModulePath',
])

function adapterEnv(source = process.env) {
  const env = {}
  for (const key of ADAPTER_ENV_KEYS) {
    const value = source?.[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  return env
}

export const MAX_OCR_BYTES = 200_000
export const MAX_OCR_MS = 30_000

export function ocrConfigured() {
  return Boolean(process.env.ADVISERS_OCR_CMD)
}

function resolveContainedFile(file, cwd, label) {
  if (typeof file !== 'string' || !file) throw new Error(label + ' path is required')
  const rootLexical = resolve(cwd)
  let root
  try {
    root = realpathSync(rootLexical)
  } catch {
    throw new Error(label + ' workspace does not exist: ' + cwd)
  }
  const abs = resolve(rootLexical, file)
  const lexicalRel = relative(rootLexical, abs)
  if (lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) throw new Error(label + ' file escapes workspace: ' + file)
  let real
  try {
    real = realpathSync(abs)
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(label + ' file not found: ' + file)
    throw error
  }
  const realRel = relative(root, real)
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error(label + ' file escapes workspace through a symlink: ' + file)
  const info = statSync(real)
  if (!info.isFile()) throw new Error('not a file: ' + file)
  if (info.size > 10 * 1024 * 1024) throw new Error(label + ' file is larger than 10 MB')
  return real
}

export function assertOcrPath(file, cwd = process.cwd()) {
  return resolveContainedFile(file, cwd, 'OCR')
}
export async function runLocalOcr(file, { cmd = process.env.ADVISERS_OCR_CMD, timeoutMs = MAX_OCR_MS, cwd = process.cwd() } = {}) {
  if (!cmd) throw new Error('OCR is not configured; set ADVISERS_OCR_CMD to a local OCR executable (no cloud OCR is used)')
  const abs = assertOcrPath(file, cwd)
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [abs], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true, env: adapterEnv() })
    let out = '', err = ''
    child.stdout.on('data', (b) => { out += b.toString('utf8'); if (out.length > MAX_OCR_BYTES) { child.kill(); reject(new Error(`OCR output exceeds ${MAX_OCR_BYTES} chars`)) } })
    child.stderr.on('data', (b) => { err += b.toString('utf8') })
    child.on('error', (e) => reject(new Error(`OCR command failed to start: ${e.message}`)))
    child.on('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`OCR command exited ${code ?? signal}: ${err.trim().slice(0, 300)}`))
      const text = out.replace(/\r\n/g, '\n').trim()
      if (!text) return reject(new Error('OCR returned no text'))
      resolvePromise(text)
    })
  })
}
