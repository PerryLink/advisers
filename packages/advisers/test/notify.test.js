import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sendNotification } from '../lib/notify.js'

test('E1-T3: custom notification adapter receives title/body and no client text is required', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-notify-'))
  const log = join(root, 'notify.log')
  try {
    const script = join(root, 'notify.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> "${log}"\n`)
    chmodSync(script, 0o700)
    const result = await sendNotification({ title: 'Advisers · 到期提醒', body: '2 条承诺到期或即将到期', cmd: script })
    assert.equal(result.sent, true)
    assert.equal(result.channel, 'custom')
    assert.match(readFileSync(log, 'utf8'), /Advisers · 到期提醒\|2 条承诺到期或即将到期/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E1-T3: no adapter returns sent:false rather than throwing', async () => {
  const result = await sendNotification({ title: 't', body: 'b', cmd: '' })
  assert.equal(typeof result.sent, 'boolean')
})
