import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { ofdText, extractAttachment } from '../lib/attachments.js'

async function fixture() {
  const zip = new JSZip()
  zip.file('OFD.xml', '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>')
  zip.file('Doc_0/Document.xml', '<?xml version="1.0"?><ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Pages><ofd:Page ID="1">Pages/Page_0/Content.xml</ofd:Page></ofd:Pages></ofd:Document>')
  zip.file('Doc_0/Pages/Page_0/Content.xml', '<?xml version="1.0"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:TextObject><ofd:TextCode>周五前给王工发报价</ofd:TextCode></ofd:TextObject></ofd:Content></ofd:Page>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('E7: OFD text extraction and attachment support', async () => {
  const buf = await fixture()
  assert.match(await ofdText(buf), /周五前给王工发报价/)
  const root = mkdtempSync(join(tmpdir(), 'advisers-ofd-'))
  try {
    writeFileSync(join(root, 'x.ofd'), buf)
    const got = await extractAttachment('x.ofd', { cwd: root })
    assert.equal(got.kind, 'ofd')
    assert.match(got.text, /周五前给王工发报价/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
