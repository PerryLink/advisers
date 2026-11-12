#!/usr/bin/env node
/** Pack dry-run smoke: every publishable package must contain its runtime files. */
import { execFileSync } from 'node:child_process'
const packages = [
  ['packages/core', 'advisers-core', 'dist/index.js'],
  ['packages/office', 'advisers-office', 'dist/index.js'],
  ['packages/policy-strict', 'advisers-policy-strict', 'dist/index.js'],
  ['packages/bridge-hermes', 'advisers-bridge-hermes', 'dist/index.js'],
  ['packages/advisers', 'advisers', 'bin/advisers.js'],
  ['packages/dsh-advisers', 'dsh-advisers', 'index.js'],
]
let failed = false
for (const [dir, name, required] of packages) {
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const info = JSON.parse(raw)[0]
    const files = info.files.map((f) => f.path)
    if (!files.includes(required)) throw new Error(`missing ${required}`)
    console.log(`PASS ${name}@${info.version} (${files.length} files, incl ${required})`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${String(error.stderr || error.message).slice(0, 500)}`)
  }
}
if (failed) process.exit(1)
