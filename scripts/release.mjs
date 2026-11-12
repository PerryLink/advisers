#!/usr/bin/env node
/**
 * Publish via npm staged publishing. Direct `npm publish` now stages versions
 * that need an OTP; approving them is a separate, human step.
 *
 *   node scripts/release.mjs            # stage all packages, print IDs
 *   NPM_OTP=123456 node scripts/release.mjs  # stage + approve (if the token allows)
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packages = [
  ['packages/core', 'advisers-core'],
  ['packages/office', 'advisers-office'],
  ['packages/policy-strict', 'advisers-policy-strict'],
  ['packages/bridge-hermes', 'advisers-bridge-hermes'],
  ['packages/advisers', 'advisers'],
  ['packages/dsh-advisers', 'dsh-advisers'],
]
const tag = process.env.RELEASE_TAG || 'next'
const otp = process.env.NPM_OTP
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let rcDir
let env = { ...process.env }
if (process.env.NPM_TOKEN) {
  rcDir = mkdtempSync(join(tmpdir(), 'advisers-release-'))
  const rc = join(rcDir, '.npmrc')
  writeFileSync(rc, 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
  env = { ...env, NPM_CONFIG_USERCONFIG: rc }
}

const version = (cwd) => JSON.parse(execFileSync('node', ['-p', "JSON.stringify(require('./package.json'))"], { cwd, encoding: 'utf8' })).version

async function tarballOk(name, ver) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${ver}.tgz`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
    return r.status === 200
  } catch {
    return false
  }
}

function stagedId(text) {
  return /staged with id ([0-9a-f-]{36})/i.exec(text)?.[1]
}

try {
  if (process.env.ADVISERS_RELEASE_ALLOW_DIRTY !== '1') {
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
      if (dirty) throw new Error('working tree is dirty; commit first or set ADVISERS_RELEASE_ALLOW_DIRTY=1')
    } catch (error) {
      if (String(error.message).includes('dirty')) throw error
    }
  }
  execFileSync('pnpm', ['-r', '--if-present', 'run', 'build'], { cwd: root, stdio: 'inherit' })
  for (const [dir, name] of packages) {
    const cwd = join(root, dir)
    const ver = await version(cwd)
    console.log(`\n== ${name}@${ver} (${tag})`)
    let id
    try {
      const out = execFileSync('npm', ['stage', 'publish', '--tag', tag], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      id = stagedId(out)
      console.log(out.trim().split('\n').slice(-1)[0])
    } catch (error) {
      const text = `${error.stdout || ''}\n${error.stderr || ''}`
      if (!/E409|previously published|already staged/.test(text)) throw error
      console.log('already published or staged; locate the stage id with `npm stage list`')
    }
    if (!id) continue
    if (!otp) {
      console.log(`  staged: ${id}`)
      console.log(`  approve: npm stage approve ${id}   (then complete the browser OTP)`)
      continue
    }
    execFileSync('npm', ['stage', 'approve', id, '--otp', otp], { cwd, env, encoding: 'utf8' })
    let ok = false
    for (let i = 0; i < 60; i++) {
      if (await tarballOk(name, ver)) { ok = true; break }
      await sleep(3000)
    }
    if (!ok) throw new Error(`${name}@${ver} staged but tarball is still 404`)
    console.log(`  approved and verified: ${name}@${ver}`)
  }
  if (!otp) console.log('\nAll packages staged. Approve each ID in npm (OTP required); tags move on approval.')
} finally {
  if (rcDir) rmSync(rcDir, { recursive: true, force: true })
}
