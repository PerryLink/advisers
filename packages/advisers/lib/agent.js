import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { chatCompletion } from './model.js'

const OFFICE_KINDS = ['docx', 'xlsx', 'pptx', 'xmind', 'mermaid', 'drawio']
const TEMPLATE_NAMES = ['weekly', 'budget', 'presentation', 'flow', 'mindmap']
const MAX_FILE_BYTES = 1_000_000

let officeModule

async function loadOffice() {
  if (officeModule) return officeModule
  try {
    officeModule = await import('advisers-office')
  } catch {
    officeModule = await import('../../office/dist/index.js')
  }
  return officeModule
}

function safePath(cwd, input) {
  const abs = resolve(cwd, input || '.')
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace: ${input}`)
  return abs
}

function tool(name, description, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', additionalProperties: false, properties, required },
    },
  }
}

export const LOCAL_TOOLS = [
  tool('office_build', 'Build an Office/diagram artifact from a JSON spec. Returns the file path and validation result.', {
    kind: { type: 'string', enum: OFFICE_KINDS },
    out: { type: 'string', description: 'Relative output path inside the workspace, e.g. out/q4.docx' },
    spec: { type: 'object', description: 'Spec matching the chosen builder (title/sections/columns/rows/slides/nodes).' },
  }, ['kind', 'out', 'spec']),
  tool('office_template', 'Build one of the five secretary templates into a file.', {
    name: { type: 'string', enum: TEMPLATE_NAMES },
    out: { type: 'string', description: 'Relative output path inside the workspace.' },
    data: { type: 'object', description: 'Template input data (period/done/rows/title/steps/branches).' },
  }, ['name', 'out', 'data']),
  tool('file_write', 'Write UTF-8 text to a file inside the workspace (max 1 MB).', {
    path: { type: 'string' },
    content: { type: 'string' },
  }, ['path', 'content']),
  tool('file_read', 'Read a UTF-8 text file inside the workspace (max 1 MB).', {
    path: { type: 'string' },
  }, ['path']),
  tool('file_list', 'List files in a workspace directory.', {
    dir: { type: 'string', description: 'Relative directory, default .' },
  }, []),
]

async function runOfficeTool(name, args, cwd) {
  const office = await loadOffice()
  const out = safePath(cwd, args.out)
  await mkdir(dirname(out), { recursive: true })
  let spec
  if (name === 'office_build') {
    if (!OFFICE_KINDS.includes(args.kind)) throw new Error(`unsupported kind: ${args.kind}`)
    spec = args.spec
  } else {
    if (!TEMPLATE_NAMES.includes(args.name)) throw new Error(`unsupported template: ${args.name}`)
    spec = args.name === 'weekly' ? office.weeklyReport(args.data)
      : args.name === 'budget' ? office.budget(args.data)
      : args.name === 'presentation' ? office.presentation(args.data)
      : args.name === 'flow' ? office.flow(args.data)
      : office.mindmap(args.data)
  }
  let buffer
  let result
  const kind = name === 'office_build' ? args.kind : (args.name === 'budget' ? 'xlsx' : args.name === 'presentation' ? 'pptx' : (args.name === 'flow' || args.name === 'mindmap') ? 'mermaid' : 'docx')
  if (kind === 'docx') { buffer = await office.buildDocx(spec); result = await office.validateOffice(buffer, 'docx') }
  else if (kind === 'xlsx') { buffer = await office.buildXlsx(spec); result = await office.validateOffice(buffer, 'xlsx') }
  else if (kind === 'pptx') { buffer = await office.buildPptx(spec); result = await office.validateOffice(buffer, 'pptx') }
  else if (kind === 'xmind') { buffer = await office.buildXmind(spec); result = await office.validateXmind(buffer) }
  else if (kind === 'drawio') { buffer = Buffer.from(office.buildDrawio(spec)); result = { ok: true, missing: [] } }
  else { buffer = Buffer.from(office.buildMermaid(spec)); result = { ok: true, missing: [] } }
  await writeFile(out, buffer)
  return { ok: result.ok, path: out, bytes: buffer.length, missing: result.missing ?? [] }
}

export async function executeTool(name, args, { cwd = process.cwd() } = {}) {
  if (name === 'office_build' || name === 'office_template') return runOfficeTool(name, args, cwd)
  if (name === 'file_write') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new Error('content is missing or too large')
    const path = safePath(cwd, args.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, args.content)
    return { ok: true, path, bytes: Buffer.byteLength(args.content) }
  }
  if (name === 'file_read') {
    const path = safePath(cwd, args.path)
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('file is too large')
    return { ok: true, path, content }
  }
  if (name === 'file_list') {
    const path = safePath(cwd, args.dir ?? '.')
    const entries = await readdir(path, { withFileTypes: true })
    return { ok: true, dir: path, entries: entries.slice(0, 200).map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`) }
  }
  throw new Error(`unknown tool: ${name}`)
}

const SYSTEM = `You are a work secretary, not a chatbot.
- Reply in the user's language, BLUF, no filler.
- Use tools to create files or read workspace files. Never claim a file exists unless the tool succeeded.
- For Office work, choose the right builder/template, put deliverables under out/ unless the user says otherwise.
- If the request is ambiguous and the answer would change the deliverable, ask one short question instead of guessing.
- Do not invent facts. Keep private matters private.`

export async function runAgent({
  runtime,
  text,
  context,
  apiKey,
  baseUrl,
  model,
  cwd = process.cwd(),
  maxSteps = 8,
  fetchImpl = fetch,
  onTool,
}) {
  const messages = [
    { role: 'system', content: `${SYSTEM}\n\n${context.prompt}` },
    { role: 'user', content: text },
  ]
  const artifacts = []
  const toolLog = []
  for (let step = 0; step < maxSteps; step++) {
    const result = await chatCompletion({ messages, apiKey, baseUrl, model, tools: LOCAL_TOOLS, fetchImpl })
    if (!result.toolCalls.length) return { reply: result.content.trim(), artifacts, toolLog, steps: step + 1 }
    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      const name = call.function?.name
      const id = call.id ?? `call_${randomUUID()}`
      let payload
      try {
        const args = JSON.parse(call.function?.arguments || '{}')
        onTool?.(name, args)
        payload = await executeTool(name, args, { cwd })
        if (payload.path) artifacts.push(payload.path)
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      toolLog.push({ name, ok: payload.ok !== false, payload })
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(payload) })
    }
  }
  return { reply: '任务步骤超过上限，已停止；已完成的部分见文件。', artifacts, toolLog, steps: maxSteps }
}
