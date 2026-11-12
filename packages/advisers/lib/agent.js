import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { chatCompletion } from './model.js'
import { backupBeforeWrite } from './undo.js'

const OFFICE_KINDS = ['docx', 'xlsx', 'pptx', 'xmind', 'mermaid', 'drawio']
const TEMPLATE_NAMES = ['weekly', 'budget', 'presentation', 'flow', 'mindmap', 'minutes', 'notice']
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

const DENY_SEGMENTS = new Set(['.git', '.hg', '.svn', '.dsh', '.github', 'node_modules'])
const DENY_FILES = new Set(['package.json', 'pnpm-lock.yaml', '.npmrc', 'soul.md', 'state.db', 'state.db-wal', 'state.db-shm'])

function safePath(cwd, input) {
  const root = realpathSync(cwd)
  const abs = resolve(root, input || '.')
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace: ${input}`)
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  for (const part of parts) {
    if (DENY_SEGMENTS.has(part) || DENY_FILES.has(part)) throw new Error(`path is protected: ${part}`)
    if (part.startsWith('.env')) throw new Error(`path is protected: ${part}`)
  }
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`symlink is not allowed: ${part}`)
  }
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error('symlink target is not allowed')
  const parent = dirname(abs)
  if (existsSync(parent)) {
    const realParent = realpathSync(parent)
    const parentRel = relative(root, realParent)
    if (parentRel.startsWith('..') || isAbsolute(parentRel)) throw new Error('path escapes workspace through a symlink')
  }
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
  tool('office_build', 'Build an Office/diagram artifact from a JSON spec. For xmind, spec must be {title,branches:[{label,children:string[]}]}; for mermaid/drawio, spec must be {kind:"flowchart",title,nodes:[{id,label}],edges:[{from,to,label?}]}.', {
    kind: { type: 'string', enum: OFFICE_KINDS },
    out: { type: 'string', description: 'Relative output path inside the workspace, e.g. out/q4.docx' },
    spec: { type: 'object', description: 'Spec matching the chosen builder. docx:{title,sections}; xlsx:{columns,rows}; pptx:{title,slides}; xmind:{title,branches}; mermaid/drawio:{title,nodes,edges}.' },
  }, ['kind', 'out', 'spec']),
  tool('office_edit', 'Surgically edit an existing DOCX/XLSX/PPTX. Call office_read first. ops examples: {"op":"docx.setText","block":2,"text":"..."}; {"op":"xlsx.setCell","sheet":"预算","ref":"B2","value":200}; {"op":"pptx.setText","slide":1,"text":"..."}.', {
    path: { type: 'string' },
    out: { type: 'string' },
    ops: { type: 'array', items: { type: 'object' } },
  }, ['path', 'ops']),
  tool('office_read', 'Read an existing DOCX/XLSX/PPTX and return structural text. Use before editing an existing file.', {
    path: { type: 'string' },
    max_chars: { type: 'number' },
  }, ['path']),
  tool('office_template', 'Build one of the secretary templates. data must match: weekly {period,done[],risks?,next?}; budget {rows:[{item,amount,owner?}]}; presentation {title,conclusion,bullets[]}; flow {title,steps[]}; mindmap {title,branches:[{label,children?}]}; minutes {date,agenda[],decisions?,actions?}; notice {title,issuer,recipients[],body[],signer,date}.', {
    name: { type: 'string', enum: TEMPLATE_NAMES },
    out: { type: 'string', description: 'Relative output path inside the workspace.' },
    data: { type: 'object', description: 'Exact template input: weekly {period,done[],risks?,next?}; budget {rows:[{item,amount}]}; presentation {title,conclusion,bullets[]}; flow {title,steps[]}; mindmap {title,branches}.' },
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
  tool('routine_view', 'Read one active routine by id. Use the routine index in context to choose.', {
    id: { type: 'string' },
  }, ['id']),
  tool('commitment_add', 'Record a promise with its evidence. Use before saying you will remind/follow up.', {
    action: { type: 'string' },
    dueAt: { type: 'string', description: 'ISO timestamp or omit' },
    creditor: { type: 'string' },
    debtor: { type: 'string', enum: ['user', 'agent'] },
    quote: { type: 'string', description: 'The exact user words that created the promise' },
  }, ['action', 'quote']),
  tool('search_memory', 'Search confirmed facts and preferences. Use before guessing what you already know.', {
    query: { type: 'string' },
  }, ['query']),
  tool('search_turns', 'Search older conversation turns by keyword when the current window is insufficient.', {
    query: { type: 'string' },
  }, ['query']),
]

function validateTemplate(name, data) {
  if (!data || typeof data !== 'object') throw new Error(`${name} data must be an object`)
  if (name === 'weekly' && (!data.period || !Array.isArray(data.done) || data.done.length === 0)) throw new Error('weekly data requires period and non-empty done[]')
  if (name === 'budget' && (!Array.isArray(data.rows) || data.rows.length === 0)) throw new Error('budget data requires non-empty rows:[{item,amount}]')
  if (name === 'presentation' && (!data.title || !data.conclusion || !Array.isArray(data.bullets))) throw new Error('presentation data requires title, conclusion, bullets[]')
  if (name === 'flow' && (!data.title || !Array.isArray(data.steps) || data.steps.length === 0)) throw new Error('flow data requires title and non-empty steps[]')
  if (name === 'mindmap' && (!data.title || !Array.isArray(data.branches) || data.branches.length === 0)) throw new Error('mindmap data requires title and non-empty branches[]')
}

async function runOfficeTool(name, args, cwd, backupDir) {
  const office = await loadOffice()
  const out = safePath(cwd, args.out)
  await mkdir(dirname(out), { recursive: true })
  let spec
  if (name === 'office_build') {
    if (!OFFICE_KINDS.includes(args.kind)) throw new Error(`unsupported kind: ${args.kind}`)
    spec = args.spec
    if (args.kind === 'xmind' && (!Array.isArray(spec?.branches) || spec.branches.length === 0)) {
      throw new Error('xmind spec requires a non-empty branches array: [{label, children: string[]}]')
    }
    if (args.kind === 'xlsx' && (!Array.isArray(spec?.columns) || !Array.isArray(spec?.rows) || spec.rows.length === 0)) {
      throw new Error('xlsx spec requires non-empty columns[] and rows[]')
    }
    if (args.kind === 'docx' && (!spec?.title || !Array.isArray(spec?.sections))) {
      throw new Error('docx spec requires title and sections[]')
    }
    if (args.kind === 'pptx' && (!spec?.title || !Array.isArray(spec?.slides))) {
      throw new Error('pptx spec requires title and slides[]')
    }
    if ((args.kind === 'mermaid' || args.kind === 'drawio') && (!Array.isArray(spec?.nodes) || spec.nodes.length === 0)) {
      throw new Error('diagram spec requires nodes: [{id,label}]')
    }
  } else {
    if (!TEMPLATE_NAMES.includes(args.name)) throw new Error(`unsupported template: ${args.name}`)
    validateTemplate(args.name, args.data)
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
  await backupBeforeWrite(out, { cwd, backupDir })
  await writeFile(out, buffer)
  return { ok: result.ok, artifact: true, path: out, bytes: buffer.length, missing: result.missing ?? [] }
}

function writeTarget(name, args, cwd) {
  try {
    if (name === 'office_build' || name === 'office_template') return safePath(cwd, args.out)
    if (name === 'office_edit') return safePath(cwd, args.out || args.path)
    if (name === 'file_write') return safePath(cwd, args.path)
  } catch {
    return null
  }
  return null
}

export async function executeTool(name, args, { cwd = process.cwd(), ledger, backupDir, store, matterId, turnId } = {}) {
  if (name === 'office_build' || name === 'office_template') return runOfficeTool(name, args, cwd, backupDir)
  if (name === 'file_write') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new Error('content is missing or too large')
    const path = safePath(cwd, args.path)
    await mkdir(dirname(path), { recursive: true })
    await backupBeforeWrite(path, { cwd, backupDir })
    await writeFile(path, args.content)
    return { ok: true, artifact: true, path, bytes: Buffer.byteLength(args.content) }
  }
  if (name === 'file_read') {
    const path = safePath(cwd, args.path)
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('file is too large')
    return { ok: true, artifact: false, path, content }
  }
  if (name === 'office_edit') {
    const source = safePath(cwd, args.path)
    const target = safePath(cwd, args.out || args.path)
    const office = await loadOffice()
    const ext = source.split('.').pop()?.toLowerCase()
    if (!['docx', 'xlsx', 'pptx'].includes(ext)) throw new Error('office_edit supports docx/xlsx/pptx')
    const result = await office.editOffice(await readFile(source), ext, args.ops)
    if (!result.ok) throw new Error(result.error || 'edit failed')
    await mkdir(dirname(target), { recursive: true })
    await backupBeforeWrite(target, { cwd, backupDir })
    await writeFile(target, result.buffer)
    return { ok: true, artifact: true, path: target, bytes: result.buffer.length, changes: result.changes }
  }
  if (name === 'office_read') {
    const target = safePath(cwd, args.path)
    const office = await loadOffice()
    const doc = await office.readOffice(await readFile(target))
    const text = office.officeToText(doc, Math.min(Number(args.max_chars) || 20_000, 50_000))
    return { ok: true, artifact: false, kind: doc.kind, text }
  }
  if (name === 'commitment_add') {
    if (!ledger || !matterId) throw new Error('commitment_add requires a ledger and matter')
    const commitment = ledger.addCommitment({
      matterId,
      debtor: args.debtor === 'agent' ? 'agent' : 'user',
      creditor: args.creditor || 'me',
      action: args.action,
      dueAt: args.dueAt,
      capability: 'todo',
      evidence: [{ sessionId: turnId || 'local', turnId: turnId || 'local', quote: args.quote }],
    })
    return { ok: true, artifact: false, commitment }
  }
  if (name === 'search_memory') {
    if (!ledger) throw new Error('search_memory requires a ledger')
    return { ok: true, artifact: false, results: ledger.searchMemory(args.query) }
  }
  if (name === 'search_turns') {
    const rows = store?.searchTurns(args.query, { limit: 6 }) ?? []
    return { ok: true, artifact: false, results: rows.map((r) => ({ seq: r.seq, role: r.role, content: r.content.slice(0, 300) })) }
  }
  if (name === 'routine_view') {
    const routine = ledger?.listRoutines().find((r) => r.id === args.id && (r.status === 'active' || r.status === 'stale'))
    if (!routine) throw new Error(`unknown routine: ${args.id}`)
    return { ok: true, artifact: false, routine }
  }
  if (name === 'file_list') {
    const path = safePath(cwd, args.dir ?? '.')
    const entries = await readdir(path, { withFileTypes: true })
    return { ok: true, artifact: false, dir: path, entries: entries.slice(0, 200).map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`) }
  }
  throw new Error(`unknown tool: ${name}`)
}

const SYSTEM = `You are a work secretary, not a chatbot.
Advisers is a local CLI: \`advisers\` starts the REPL, \`advisers chat "task"\` runs one task, \`advisers status\` shows state, \`advisers office\`/\`advisers template\` build files. It is NOT a directory of consultants; never invent product features.
- Reply in the user's language, BLUF, no filler.
- Use tools to create files only when the user asks for a document/file or the task clearly needs one; otherwise answer in chat. Never claim a file exists unless the tool succeeded.
- For Office work, choose the right builder/template, put deliverables under out/ unless the user says otherwise.
- If the request is ambiguous and the answer would change the deliverable, ask one short question instead of guessing.
- Do not invent facts. Keep private matters private.
- If you promise to remind or follow up, call commitment_add first; never make an empty promise.`

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
  confirm,
  force = false,
  backupDir,
  store,
  matterId,
  turnId,
  history = [],
  summary = '',
  ledger,
}) {
  const historyBlock = summary ? `\n\n<session-summary>\n${summary}\n</session-summary>` : ''
  const messages = [
    { role: 'system', content: `${SYSTEM}\n\n${context.prompt}${historyBlock}` },
    ...history.filter((t) => t.role === 'user' || t.role === 'assistant').map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: text },
  ]
  const artifacts = []
  const toolLog = []
  for (let step = 0; step < maxSteps; step++) {
    const result = await chatCompletion({ messages, apiKey, baseUrl, model, tools: LOCAL_TOOLS, fetchImpl })
    if (!result.toolCalls.length) return { reply: result.content.trim(), artifacts: [...new Set(artifacts)], toolLog, steps: step + 1 }
    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      const name = call.function?.name
      const id = call.id ?? `call_${randomUUID()}`
      let payload
      try {
        const args = JSON.parse(call.function?.arguments || '{}')
        onTool?.(name, args)
        const target = writeTarget(name, args, cwd)
        if (target && !force && existsSync(target)) {
          const allowed = confirm ? await confirm({ tool: name, path: target }) : false
          if (!allowed) {
            return { reply: `未覆盖 ${target}。如需覆盖，请确认或设置 ADVISERS_FORCE=1。`, artifacts: [...new Set(artifacts)], toolLog, declined: true, steps: step + 1 }
          }
        }
        payload = await executeTool(name, args, { cwd, ledger, backupDir, store, matterId, turnId })
        if (payload.artifact && payload.path) artifacts.push(payload.path)
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      toolLog.push({ name, ok: payload.ok !== false, payload })
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(payload) })
    }
  }
  return { reply: '任务步骤超过上限，已停止；已完成的部分见文件。', artifacts: [...new Set(artifacts)], toolLog, steps: maxSteps }
}
