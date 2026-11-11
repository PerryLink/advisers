export type DiagramKind = 'flowchart' | 'mindmap' | 'gantt'

export interface DiagramNode {
  id: string
  label: string
  shape?: 'box' | 'round' | 'diamond' | 'stadium'
}

export interface DiagramEdge {
  from: string
  to: string
  label?: string
}

export interface DiagramBranch {
  label: string
  children?: string[]
}

export interface DiagramTask {
  name: string
  id?: string
  start: string
  duration: string
  section?: string
}

export interface DiagramSpec {
  kind: DiagramKind
  title: string
  direction?: 'TD' | 'LR'
  nodes?: DiagramNode[]
  edges?: DiagramEdge[]
  branches?: DiagramBranch[]
  tasks?: DiagramTask[]
}

function esc(text: string): string {
  return text.replace(/"/g, "'").replace(/\r?\n/g, ' ')
}

function shape(node: DiagramNode): string {
  const label = esc(node.label)
  if (node.shape === 'round') return `("${label}")`
  if (node.shape === 'diamond') return `{"${label}"}`
  if (node.shape === 'stadium') return `(["${label}"])`
  return `["${label}"]`
}

export function buildMermaid(spec: DiagramSpec): string {
  if (spec.kind === 'mindmap') {
    const lines = ['mindmap', `  root((${esc(spec.title)}))`]
    for (const branch of spec.branches ?? []) {
      lines.push(`    ${esc(branch.label)}`)
      for (const child of branch.children ?? []) lines.push(`      ${esc(child)}`)
    }
    return lines.join('\n') + '\n'
  }
  if (spec.kind === 'gantt') {
    const lines = ['gantt', `  title ${esc(spec.title)}`, '  dateFormat YYYY-MM-DD', '  axisFormat %m-%d']
    let section = ''
    for (const task of spec.tasks ?? []) {
      if (task.section && task.section !== section) {
        section = task.section
        lines.push(`  section ${esc(section)}`)
      }
      lines.push(`  ${esc(task.name)} :${task.id ?? ''}, ${task.start}, ${task.duration}`)
    }
    return lines.join('\n') + '\n'
  }

  const lines = [`flowchart ${spec.direction ?? 'TD'}`]
  for (const node of spec.nodes ?? []) lines.push(`  ${node.id}${shape(node)}`)
  for (const edge of spec.edges ?? []) {
    const label = edge.label ? `|${esc(edge.label)}|` : ''
    lines.push(`  ${edge.from} -->${label} ${edge.to}`)
  }
  return lines.join('\n') + '\n'
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildDrawio(spec: DiagramSpec): string {
  const nodes = spec.nodes ?? []
  const edges = spec.edges ?? []
  const cells: string[] = []
  const positions = new Map<string, { x: number; y: number }>()
  nodes.forEach((node, index) => {
    const x = 40 + (index % 4) * 200
    const y = 40 + Math.floor(index / 4) * 120
    positions.set(node.id, { x, y })
    const style =
      node.shape === 'diamond'
        ? 'rhombus;whiteSpace=wrap;html=1;'
        : node.shape === 'round'
          ? 'rounded=1;whiteSpace=wrap;html=1;'
          : 'rounded=0;whiteSpace=wrap;html=1;'
    cells.push(
      `<mxCell id="${xml(node.id)}" value="${xml(node.label)}" style="${style}" vertex="1" parent="1">` +
        `<mxGeometry x="${x}" y="${y}" width="140" height="60" as="geometry"/></mxCell>`,
    )
  })
  edges.forEach((edge, index) => {
    cells.push(
      `<mxCell id="edge-${index}" value="${xml(edge.label ?? '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" ` +
        `edge="1" parent="1" source="${xml(edge.from)}" target="${xml(edge.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    )
  })
  return (
    `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`
  )
}
