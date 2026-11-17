import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Privacy audit P2-2: `privacy --prove` used to present two hardcoded constants
// as proof, list only two egress surfaces and expose internal numbering
// ("E9-T3"). It must now read as an honest local self-attestation, list the real
// egress surfaces (learn review / IMAP / webhook / sync / MCP / DSH / pet brief /
// OCR / timestamp) and not leak internal IDs.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home) {
  const base = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' }
  delete base.ADVISERS_MODEL
  delete base.ADVISERS_BASE_URL
  return tosEnv(home, base)
}
function run(home, args) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home), encoding: 'utf8' })
}

test('bin privacy --prove is honest self-attestation and lists every egress surface', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-privacy-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    run(home, ['commit', 'add', '发报价', '--quote', 'q'])
    const out = run(home, ['privacy', '--prove'])
    assert.match(out, /self-attestation/i)
    assert.match(out, /self-check/i)
    assert.match(out, /not a third-party audit|不是第三方审计/i)
    for (const needle of ['learn review', 'IMAP', 'webhook', 'sync', 'MCP', 'DSH', 'pet-brief', 'ocr', 'timestamp']) {
      assert.ok(out.includes(needle), `privacy --prove must list the ${needle} egress surface`)
    }
    assert.doesNotMatch(out, /E9-T3/, 'internal numbering must not be exposed')
    assert.doesNotMatch(out, /SEC2-|P1-\d|P2-\d/, 'internal audit IDs must not be exposed')
    // The default model fact was wrong (deepseek-chat) while model.js uses deepseek-flash.
    assert.doesNotMatch(out, /deepseek-chat/)
    assert.match(out, /deepseek-flash/)
    for (const name of ['audit verified', 'telemetry disabled', 'no default network egress', 'secret matter fail-closed']) {
      assert.match(out, new RegExp('\\[PASS\\] ' + name), name)
    }
    // Every PASS line must be labelled as a local self-check, not as external proof.
    for (const line of out.split('\n').filter((row) => row.startsWith('[PASS]') || row.startsWith('[FAIL]'))) {
      assert.match(line, /local self-check/i, line)
    }

    const json = JSON.parse(run(home, ['privacy', '--json']))
    assert.equal(json.telemetry, 'none')
    assert.equal(json.default_egress, 'none')
    assert.ok(Array.isArray(json.explicit_egress))
    assert.ok(json.explicit_egress.some((row) => /IMAP/.test(row)))
    assert.ok(json.explicit_egress.some((row) => /webhook/.test(row)))
    assert.ok(json.explicit_egress.some((row) => /MCP/.test(row)))
    assert.doesNotMatch(JSON.stringify(json), /E9-T3/)
    assert.match(json.provider.model, /deepseek-flash/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
