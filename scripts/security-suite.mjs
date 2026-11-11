#!/usr/bin/env node
/** T1–T5 local security suite. External egress/real-link tests are separate. */
import { execFileSync } from 'node:child_process'
const suites = [
  ['T1 cross-matter leak', 'packages/core/test/security.test.ts'],
  ['T2 permit replay/expiry', 'packages/core/test/permit.test.ts'],
  ['T3 companion/roleplay denial', 'packages/policy-strict/test/policy.test.ts'],
  ['T4 audit hash chain tamper', 'packages/advisers/test/sqlite.test.js'],
  ['T5 deletion cascade', 'packages/core/test/security.test.ts'],
]
for (const [name, file] of suites) {
  try {
    execFileSync('node', ['--experimental-strip-types', '--test', file], { stdio: 'pipe', encoding: 'utf8' })
    console.log(`PASS ${name} (${file})`)
  } catch (error) {
    console.error(`FAIL ${name} (${file})`)
    console.error(String(error.stdout ?? error.stderr ?? error.message).slice(0, 1000))
    process.exitCode = 1
  }
}
