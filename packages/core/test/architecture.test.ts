import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SRC = new URL('../src/', import.meta.url).pathname

test('core source has no host imports (cordis, DSH, or platform SDKs)', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
  const offenders: string[] = []
  for (const file of files) {
    const text = readFileSync(join(SRC, file), 'utf8')
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1] ?? ''
      if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('node:')) {
        offenders.push(`${file}: ${spec}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('core source does not reference fork-only cordis symbols', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
  const text = files.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n')
  assert.doesNotMatch(text, /FiberState/)
  assert.doesNotMatch(text, /LoggerLevel/)
  assert.doesNotMatch(text, /symbols\.root/)
  assert.doesNotMatch(text, /Service\.metadata/)
})
