import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractAttachment } from '../lib/attachments.js'
import { runLocalOcr } from '../lib/ocr.js'

test('E7-T3: local OCR adapter fails closed without config and works with a local command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-ocr-'))
  const old = process.env.ADVISERS_OCR_CMD
  try {
    writeFileSync(join(root, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await assert.rejects(() => runLocalOcr('scan.png', { cwd: root, cmd: '' }), /not configured/)
    const script = join(root, 'fake-ocr.sh')
    writeFileSync(script, '#!/bin/sh\necho "识别文本：周五前发报价"\n')
    chmodSync(script, 0o700)
    process.env.ADVISERS_OCR_CMD = script
    assert.match(await runLocalOcr('scan.png', { cwd: root }), /周五前发报价/)
    const att = await extractAttachment('scan.png', { cwd: root })
    assert.equal(att.kind, 'ocr')
    assert.match(att.text, /周五前发报价/)
  } finally {
    if (old === undefined) delete process.env.ADVISERS_OCR_CMD
    else process.env.ADVISERS_OCR_CMD = old
    rmSync(root, { recursive: true, force: true })
  }
})
