#!/usr/bin/env node
/**
 * Publish packages in dependency order and wait until npm actually serves the
 * tarball before moving to the next package. npm returns 202 long before the
 * tarball is available; publishing a dependent too early creates a broken tag.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packages = [
  ['packages/core', 'advisers-core'],
  ['packages/office', 'advisers-office'],
  ['packages/advisers', 'advisers'],
  ['packages/dsh-advisers', 'dsh-advisers'],
]
const tag = process.env.RELEASE_TAG || 'next'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let rcDir
let env = { ...process.env }
if (process.env.NPM_TOKEN) {
  rcDir = mkdtempSync(join(tmpdir(), 'advisers-release-'))
  const rc = join(rcDir, '.npmrc')
  writeFileSync(rc, 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
  env = { ...env, NPM_CONFIG_USERCONFIG: rc }
}

async function version(cwd) {
  return JSON.parse(execFileSync('node', ['-p', "JSON.stringify(require('./package.json'))"], { cwd, encoding: 'utf8' })).version
}

async function tarballOk(name, ver) {
  const url = `https://registry.npmjs.org/${name}/-/${name}-${ver}.tgz`
  try {
    const r = await fetch(url, { method: 'HEAD' })
    return r.status === 200
  } catch {
    return false
  }
}

try {
  for (const [dir, name] of packages) {
    const cwd = join(root, dir)
    const ver = await version(cwd)
    console.log(`\n== ${name}@${ver} (${tag})`)
    try {
      const out = execFileSync('npm', ['publish', '--access', 'public', '--tag', tag], { cwd, env, encoding: 'utf8' })
      console.log(out.trim().split('\n').slice(-2).join(' | '))
    } catch (error) {
      const text = String(error.stderr || error.stdout || error.message)
      if (!/E409|previously published|over previously/.test(text)) throw error
      console.log('already published; verifying tarball')
    }
    let ok = false
    for (let i = 0; i < 120; i++) {
      if (await tarballOk(name, ver)) { ok = true; break }
      if (i % 6 === 0) console.log(`  waiting for tarball... ${i * 5}s`)
      await sleep(5000)
    }
    if (!ok) throw new Error(`${name}@${ver} tarball is still 404 after 10 minutes`)
    console.log(`  tarball ok: ${name}@${ver}`)
  }
  console.log('\nall packages published and verified')
} finally {
  if (rcDir) rmSync(rcDir, { recursive: true, force: true })
}
