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
import { statSync } from 'node:fs'
import { resolve, isAbsolute, relative } from 'node:path'

export const MAX_OCR_BYTES = 200_000
export const MAX_OCR_MS = 30_000

export function ocrConfigured() {
  return Boolean(process.env.ADVISERS_OCR_CMD)
}

export function assertOcrPath(file, cwd = process.cwd()) {
  const abs = resolve(cwd, file)
  const rel = relative(resolve(cwd), abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`OCR file escapes workspace: ${file}`)
  const info = statSync(abs)
  if (!info.isFile()) throw new Error(`not a file: ${file}`)
  if (info.size > 10 * 1024 * 1024) throw new Error('OCR file is larger than 10 MB')
  return abs
}

export async function runLocalOcr(file, { cmd = process.env.ADVISERS_OCR_CMD, timeoutMs = MAX_OCR_MS, cwd = process.cwd() } = {}) {
  if (!cmd) throw new Error('OCR is not configured; set ADVISERS_OCR_CMD to a local OCR executable (no cloud OCR is used)')
  const abs = assertOcrPath(file, cwd)
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [abs], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true })
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
