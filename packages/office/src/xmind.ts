import JSZip from 'jszip'
import type { DiagramSpec } from './diagram.ts'

interface XMindTopic {
  id: string
  class: 'topic'
  title: string
  children?: { attached: XMindTopic[] }
}

function topic(id: string, title: string, children: XMindTopic[] = []): XMindTopic {
  const node: XMindTopic = { id, class: 'topic', title }
  if (children.length) node.children = { attached: children }
  return node
}

/**
 * Minimal XMind 2020+ file: a ZIP with content.json, metadata.json, manifest.json.
 * Mind-map branches become attached topics; no styling yet.
 */
export async function buildXmind(spec: DiagramSpec): Promise<Buffer> {
  const branches = (spec.branches ?? []).map((branch, index) =>
    topic(
      `branch-${index}`,
      branch.label,
      (branch.children ?? []).map((child, childIndex) => topic(`leaf-${index}-${childIndex}`, child)),
    ),
  )
  const content = [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: spec.title,
      rootTopic: topic('root', spec.title, branches),
    },
  ]
  const metadata = { creator: { name: 'Advisers' }, activeSheetId: 'sheet-1' }
  const manifest = { 'file-entries': { 'content.json': {}, 'metadata.json': {} } }

  const zip = new JSZip()
  zip.file('content.json', JSON.stringify(content))
  zip.file('metadata.json', JSON.stringify(metadata))
  zip.file('manifest.json', JSON.stringify(manifest))
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

export async function validateXmind(buffer: Buffer): Promise<{ ok: boolean; missing: string[] }> {
  const zip = await JSZip.loadAsync(buffer)
  const missing = ['content.json', 'metadata.json', 'manifest.json'].filter((name) => !zip.file(name))
  return { ok: missing.length === 0, missing }
}
