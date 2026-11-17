/**
 * P2: third-party timestamp adapter (local executable).
 *
 * Advisers never calls a timestamp authority itself. The user may point
 * `ADVISERS_TIMESTAMP_CMD` at a local tool (e.g. an RFC3161 client or an
 * internal signer) that receives the file path and writes a proof to stdout.
 * Without it the feature fails closed; no network is used by Advisers.
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Environment for the adapter subprocess: an explicit allowlist.
 *
 * The adapter is a local third-party program (RFC3161 client / signer).
 * Inheriting process.env would hand it every Advisers secret — ADVISERS_API_KEY,
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

export const MAX_PROOF_BYTES = 200_000

export function timestampConfigured() {
  return Boolean(process.env.ADVISERS_TIMESTAMP_CMD)
}

export function assertProofFile(file, cwd = process.cwd()) {
  const abs = resolve(cwd, file)
  const rel = relative(resolve(cwd), abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`timestamp file escapes workspace: ${file}`)
  const info = statSync(abs)
  if (!info.isFile()) throw new Error(`not a file: ${file}`)
  if (info.size > 10 * 1024 * 1024) throw new Error('timestamp file is larger than 10 MB')
  return abs
}

export async function runLocalTimestamp(file, { cmd = process.env.ADVISERS_TIMESTAMP_CMD, timeoutMs = 30_000, cwd = process.cwd() } = {}) {
  if (!cmd) throw new Error('timestamp is not configured; set ADVISERS_TIMESTAMP_CMD to a local timestamp/signing executable')
  const abs = assertProofFile(file, cwd)
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [abs], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true, env: adapterEnv() })
    let out = '', err = ''
    child.stdout.on('data', (b) => { out += b.toString('utf8'); if (out.length > MAX_PROOF_BYTES) { child.kill(); reject(new Error(`timestamp proof exceeds ${MAX_PROOF_BYTES} bytes`)) } })
    child.stderr.on('data', (b) => { err += b.toString('utf8') })
    child.on('error', (e) => reject(new Error(`timestamp command failed to start: ${e.message}`)))
    child.on('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`timestamp command exited ${code ?? signal}: ${err.trim().slice(0, 300)}`))
      const proof = out.trim()
      if (!proof) return reject(new Error('timestamp command returned an empty proof'))
      resolvePromise(proof)
    })
  })
}
