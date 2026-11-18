import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { chatCompletion, ModelError, resolveThinking } from './model.js'
import { backupBeforeWrite } from './undo.js'
import { estimateTokens } from './context-window.js'
import { classify } from './safety/index.js'
import {
  UNTRUSTED_DATA_RULES,
  truncateUntrusted,
  wrapLegacyAttachmentText,
  untrustedBlocks,
  wrapUntrusted,
} from './untrusted.js'

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

// ---------------------------------------------------------------------------
// file-tool policy (0.2.3 security foundation)
//
// Every file path an agent tool touches goes through one policy boundary:
//   1. lexical containment inside the workspace root (default: cwd);
//   2. realpath containment, so a symlink cannot escape that root;
//   3. sensitive-path denial (.ssh/.aws/.advisers/... anywhere, /etc/shadow,
//      browser profiles, private keys, state backups);
//   4. write-only persistence denial (.bashrc, authorized_keys, autostart,
//      cron/systemd units);
//   5. an explicit, default-off allow list (allowPaths) for deliberate
//      out-of-workspace access. It can widen the workspace, never the
//      sensitive or persistence lists.
// onToolAction receives one audit record per tool invocation (allowed or not)
// so the CLI can forward it to the append-only audit chain.
// ---------------------------------------------------------------------------
const DENY_SEGMENT_NAMES = new Set([
  '.git', '.hg', '.svn', '.github', 'node_modules',
  '.dsh', '.claude', '.advisers',
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.mozilla', '.password-store',
  '.cursor', '.codex',
])
const DENY_SEGMENT_SEQUENCES = Object.freeze([
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['.config', 'hub'],
  ['.config', 'pip'],
  ['.config', 'op'],
  ['.config', '1password'],
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'microsoft-edge'],
  ['.config', 'brave-browser'],
  ['.config', 'bravesoftware'],
  ['.local', 'share', 'keyrings'],
  ['library', 'application support', 'google', 'chrome'],
  ['library', 'application support', 'firefox'],
  ['library', 'safari'],
  ['library', 'keychains'],
  ['appdata', 'roaming', 'mozilla', 'firefox'],
  ['appdata', 'local', 'google', 'chrome', 'user data'],
  ['appdata', 'local', 'microsoft', 'edge'],
])
const DENY_FILE_PATTERNS = Object.freeze([
  /^\.env(?:\.|$)/u,
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^\.npmrc$/u,
  /^soul\.md$/u,
  /^state\.db(?:-|\.|$)/u,
  /^\.netrc$/u,
  /^\.pgpass$/u,
  /^\.pypirc$/u,
  /^\.git-credentials$/u,
  /^credentials(?:\.json)?$/u,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/u,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|vault)$/u,
  /^ntuser\.dat$/u,
])
const ABSOLUTE_DENY_PREFIXES = Object.freeze([
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/etc/ssh',
  '/root',
  '/proc/self/environ',
  '/proc/1/environ',
  '/c:/windows/system32/config',
])
const WRITE_DENY_BASENAMES = new Set([
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile',
  '.zshrc', '.zprofile', '.zshenv', '.cshrc', '.kshrc',
  'authorized_keys', 'authorized_keys2', '.forward', '.rhosts', 'crontab',
])
const WRITE_DENY_SEQUENCES = Object.freeze([
  ['.config', 'autostart'],
  ['.config', 'systemd', 'user'],
  ['.local', 'share', 'systemd', 'user'],
  ['library', 'launchagents'],
  ['library', 'launchdaemons'],
])
const WRITE_DENY_FRAGMENTS = Object.freeze([
  '/etc/cron',
  '/etc/systemd/',
  '/etc/profile',
  '/etc/rc.local',
  '/etc/init.d/',
  '/start menu/programs/startup/',
])

/** Canonical policy view of a path (works for POSIX and Windows input). */
export function normalizePolicyPath(value) {
  let text = String(value == null ? '' : value).replace(/\\/gu, '/')
  text = text.replace(/^\/\/\?\/[a-zA-Z]:\//u, '/').replace(/^([a-zA-Z]):\//u, '/$1:/')
  text = text.replace(/\/{2,}/gu, '/')
  const segments = text
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase().replace(/[. ]+$/u, ''))
    .filter(Boolean)
  return { text: '/' + segments.join('/'), segments }
}

function hasSequence(segments, sequence) {
  outer: for (let index = 0; index + sequence.length <= segments.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (segments[index + offset] !== sequence[offset]) continue outer
    }
    return true
  }
  return false
}

/**
 * Reason a path is sensitive, or null. Pure: no filesystem access, so tests
 * can feed Windows/UNC/8.3-style samples on any platform.
 */
export function sensitivePathReason(value, { action = 'read' } = {}) {
  const { text, segments } = normalizePolicyPath(value)
  if (!segments.length) return null
  for (const name of DENY_SEGMENT_NAMES) {
    if (segments.includes(name)) return { code: 'SENSITIVE_PATH', reason: name + ' is protected' }
  }
  for (const sequence of DENY_SEGMENT_SEQUENCES) {
    if (hasSequence(segments, sequence)) return { code: 'SENSITIVE_PATH', reason: sequence.join('/') + ' is protected' }
  }
  const base = segments[segments.length - 1]
  for (const pattern of DENY_FILE_PATTERNS) {
    if (pattern.test(base)) return { code: 'SENSITIVE_PATH', reason: base + ' is protected' }
  }
  for (const prefix of ABSOLUTE_DENY_PREFIXES) {
    if (text === prefix || text.startsWith(prefix + '/')) return { code: 'SENSITIVE_PATH', reason: prefix + ' is protected' }
  }
  if (action === 'write') {
    if (WRITE_DENY_BASENAMES.has(base)) return { code: 'PERSISTENCE_WRITE', reason: base + ' is a persistence target and cannot be written by tools' }
    for (const sequence of WRITE_DENY_SEQUENCES) {
      if (hasSequence(segments, sequence)) return { code: 'PERSISTENCE_WRITE', reason: sequence.join('/') + ' is a persistence location' }
    }
    for (const fragment of WRITE_DENY_FRAGMENTS) {
      if (text.startsWith(fragment) || text.includes(fragment)) return { code: 'PERSISTENCE_WRITE', reason: fragment + ' is a persistence location' }
    }
  }
  return null
}

function policyError(code, message) {
  const error = new Error(message)
  error.code = code
  error.policy = true
  return error
}

function nearestRealPath(absPath) {
  let current = absPath
  const tail = []
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      return resolve(realpathSync(current), ...tail)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(basename(current))
      current = parent
    }
  }
  throw policyError('PATH_RESOLVE', 'cannot resolve path: ' + absPath)
}

function isInsideRoot(root, candidate) {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Resolve a tool path through the policy boundary and return the real target.
 * Throws an Error with a stable .code:
 *   PATH_REQUIRED | WORKSPACE_MISSING | WORKSPACE_MISMATCH | OUTSIDE_WORKSPACE |
 *   SYMLINK_ESCAPE | SENSITIVE_PATH | PERSISTENCE_WRITE | SYMLINK_TARGET
 */
export function resolveToolPath(input, options = {}) {
  const cwd = options.cwd || process.cwd()
  if (typeof input !== 'string' || !input.trim()) throw policyError('PATH_REQUIRED', 'path is required')
  const rootLexical = resolve(options.workspaceRoot || cwd)
  let root
  try {
    root = realpathSync(rootLexical)
  } catch {
    throw policyError('WORKSPACE_MISSING', 'workspace root does not exist: ' + rootLexical)
  }
  let base
  try {
    base = realpathSync(resolve(cwd))
  } catch {
    throw policyError('WORKSPACE_MISSING', 'working directory does not exist: ' + cwd)
  }
  if (!isInsideRoot(root, base)) throw policyError('WORKSPACE_MISMATCH', 'working directory is outside the workspace root')
  const allowPaths = Array.isArray(options.allowPaths) ? options.allowPaths : []
  const allowedRoots = allowPaths
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => resolve(rootLexical, entry))
  const isExplicitlyAllowed = (candidate) => allowedRoots.some((allowed) => isInsideRoot(allowed, candidate))
  const abs = resolve(base, input)
  if (!isInsideRoot(root, abs) && !isExplicitlyAllowed(abs)) {
    throw policyError('OUTSIDE_WORKSPACE', 'path escapes workspace: ' + input)
  }
  const real = nearestRealPath(abs)
  if (!isInsideRoot(root, real) && !isExplicitlyAllowed(real)) {
    throw policyError('SYMLINK_ESCAPE', 'path escapes workspace through a symlink: ' + input)
  }
  const action = options.action === 'write' ? 'write' : 'read'
  const denied = sensitivePathReason(abs, { action }) || sensitivePathReason(real, { action })
  if (denied) throw policyError(denied.code, 'path is protected: ' + denied.reason)
  if (action === 'write' && existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    throw policyError('SYMLINK_TARGET', 'symlink target is not allowed: ' + input)
  }
  return real
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
  tool('office_check', 'Run deterministic content checks on a DOCX/XLSX/PPTX (placeholders, formula errors, empty tables/sheets/slides). Does not judge correctness.', {
    path: { type: 'string' },
  }, ['path']),
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
  tool('memory_propose', 'Propose a memory candidate. The quote must be verbatim from the current user message. Nothing becomes active until the user accepts.', {
    kind: { type: 'string', enum: ['fact', 'preference', 'commitment'] },
    quote: { type: 'string' },
    subject: { type: 'string' },
    predicate: { type: 'string' },
    object: { type: 'string' },
    statement: { type: 'string' },
    preferenceKind: { type: 'string' },
    action: { type: 'string' },
    creditor: { type: 'string' },
    dueAt: { type: 'string' },
  }, ['kind', 'quote']),
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
  if (name === 'minutes' && (!data.date || !Array.isArray(data.agenda) || data.agenda.length === 0)) throw new Error('minutes data requires date and non-empty agenda[]')
  if (name === 'notice' && (!data.title || !data.issuer || !Array.isArray(data.recipients) || !Array.isArray(data.body) || !data.signer || !data.date)) throw new Error('notice data requires title, issuer, recipients[], body[], signer, date')
}

async function runOfficeTool(name, args, policy, backupDir) {
  const office = await loadOffice()
  const out = policy.resolve(args.out, 'write')
  await mkdir(dirname(out), { recursive: true })
  let spec
  if (name === 'office_build') {
    if (!OFFICE_KINDS.includes(args.kind)) throw new Error('unsupported kind: ' + args.kind)
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
    if (!TEMPLATE_NAMES.includes(args.name)) throw new Error('unsupported template: ' + args.name)
    validateTemplate(args.name, args.data)
    spec = args.name === 'weekly' ? office.weeklyReport(args.data)
      : args.name === 'budget' ? office.budget(args.data)
      : args.name === 'presentation' ? office.presentation(args.data)
      : args.name === 'flow' ? office.flow(args.data)
      : args.name === 'minutes' ? office.meetingMinutes(args.data)
      : args.name === 'notice' ? office.notice(args.data)
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
  await backupBeforeWrite(policy.lexical(args.out), { cwd: policy.cwd, backupDir })
  await writeFile(out, buffer)
  return { ok: result.ok, artifact: true, path: out, bytes: buffer.length, missing: result.missing ?? [] }
}

function toolPathSpec(name, args) {
  const value = args && typeof args === 'object' ? args : {}
  if (name === 'office_build' || name === 'office_template') return { action: 'write', input: value.out }
  if (name === 'office_edit') return { action: 'write', input: value.out || value.path }
  if (name === 'file_write') return { action: 'write', input: value.path }
  if (name === 'file_read' || name === 'office_read' || name === 'office_check') return { action: 'read', input: value.path }
  if (name === 'file_list') return { action: 'read', input: value.dir == null ? '.' : value.dir }
  return null
}

function createToolPolicy(options = {}) {
  const cwd = options.cwd || process.cwd()
  const workspaceRoot = options.workspaceRoot
  const allowPaths = Array.isArray(options.allowPaths) ? options.allowPaths : []
  const onToolAction = typeof options.onToolAction === 'function' ? options.onToolAction : null
  const turnId = options.turnId
  let root = null
  try { root = realpathSync(resolve(workspaceRoot || cwd)) } catch { root = null }
  return {
    cwd,
    workspaceRoot,
    allowPaths,
    root,
    resolve(input, action) {
      return resolveToolPath(input, { cwd, workspaceRoot, allowPaths, action })
    },
    /** Lexical path inside the workspace (used for undo manifests). */
    lexical(input) {
      return resolve(cwd, input)
    },
    async audit(entry) {
      if (!onToolAction) return
      let relativePath = null
      if (root && typeof entry.path === 'string') {
        const rel = relative(root, entry.path)
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) relativePath = rel
      }
      try {
        await onToolAction({ ...entry, relativePath, turnId: turnId || null, at: new Date().toISOString() })
      } catch {}
    },
  }
}

function writeTarget(name, args, policy) {
  try {
    const spec = toolPathSpec(name, args)
    if (!spec || spec.action !== 'write') return null
    return policy.resolve(spec.input, 'write')
  } catch {
    return null
  }
}

async function executeToolInner(name, args, policy, options) {
  const cwd = policy.cwd
  const backupDir = options.backupDir
  if (name === 'office_build' || name === 'office_template') return runOfficeTool(name, args, policy, backupDir)
  if (name === 'file_write') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new Error('content is missing or too large')
    const path = policy.resolve(args.path, 'write')
    await mkdir(dirname(path), { recursive: true })
    await backupBeforeWrite(policy.lexical(args.path), { cwd, backupDir })
    await writeFile(path, args.content)
    return { ok: true, artifact: true, path, bytes: Buffer.byteLength(args.content) }
  }
  if (name === 'file_read') {
    const path = policy.resolve(args.path, 'read')
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('file is too large')
    return { ok: true, artifact: false, path, content }
  }
  if (name === 'office_edit') {
    const source = policy.resolve(args.path, 'read')
    const target = policy.resolve(args.out || args.path, 'write')
    const targetLexical = policy.lexical(args.out || args.path)
    const office = await loadOffice()
    const ext = source.split('.').pop()?.toLowerCase()
    if (!['docx', 'xlsx', 'pptx'].includes(ext)) throw new Error('office_edit supports docx/xlsx/pptx')
    const result = await office.editOffice(await readFile(source), ext, args.ops)
    if (!result.ok) throw new Error(result.error || 'edit failed')
    await mkdir(dirname(target), { recursive: true })
    await backupBeforeWrite(targetLexical, { cwd, backupDir })
    await writeFile(target, result.buffer)
    return { ok: true, artifact: true, path: target, bytes: result.buffer.length, changes: result.changes }
  }
  if (name === 'office_check') {
    const office = await loadOffice()
    const target = policy.resolve(args.path, 'read')
    const kind = String(args.path).split('.').pop()?.toLowerCase()
    if (!['docx', 'xlsx', 'pptx'].includes(kind)) throw new Error('office_check supports docx/xlsx/pptx')
    return { ok: true, artifact: false, result: await office.checkOffice(await readFile(target), kind) }
  }
  if (name === 'office_read') {
    const target = policy.resolve(args.path, 'read')
    const office = await loadOffice()
    const doc = await office.readOffice(await readFile(target))
    const text = office.officeToText(doc, Math.min(Number(args.max_chars) || 20_000, 50_000))
    return { ok: true, artifact: false, kind: doc.kind, text }
  }
  if (name === 'commitment_add') {
    if (!options.ledger || !options.matterId) throw new Error('commitment_add requires a ledger and matter')
    const commitment = options.ledger.addCommitment({
      matterId: options.matterId,
      debtor: args.debtor === 'agent' ? 'agent' : 'user',
      creditor: args.creditor || /(?:发给|给|向|对)([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/.exec(args.action)?.[1] || 'someone',
      action: args.action,
      dueAt: args.dueAt,
      capability: 'todo',
      evidence: [{ sessionId: options.turnId || 'local', turnId: options.turnId || 'local', quote: args.quote }],
    })
    return { ok: true, artifact: false, commitment }
  }
  if (name === 'memory_propose') {
    if (!options.store) throw new Error('memory_propose requires a sqlite store')
    if (!options.userText || !options.userText.includes(args.quote)) throw new Error('evidence quote not verbatim in the current user message')
    const payload = args.kind === 'fact'
      ? { subject: args.subject || 'user', predicate: args.predicate, object: args.object, matterId: options.matterId }
      : args.kind === 'preference'
        ? { kind: args.preferenceKind || 'preference', statement: args.statement, matterId: options.matterId }
        : { matterId: options.matterId, debtor: 'user', creditor: args.creditor || 'someone', action: args.action, dueAt: args.dueAt, capability: 'none' }
    if (args.kind === 'fact' && (!payload.predicate || !payload.object)) throw new Error('fact candidates require predicate and object')
    if (args.kind === 'preference' && !payload.statement) throw new Error('preference candidates require statement')
    if (args.kind === 'commitment' && !payload.action) throw new Error('commitment candidates require action')
    const candidate = options.store.proposeCandidate({ kind: args.kind, payload, evidence: [{ quote: args.quote, turnId: options.turnId }] })
    return { ok: true, artifact: false, candidate: { id: candidate.id, kind: candidate.kind, status: candidate.status }, note: 'proposed; not active until accepted' }
  }
  if (name === 'search_memory') {
    if (!options.ledger) throw new Error('search_memory requires a ledger')
    return { ok: true, artifact: false, results: options.store?.searchMemory(args.query, { matterId: options.matterId }) ?? options.ledger.searchMemory(args.query, { matterId: options.matterId }) }
  }
  if (name === 'search_turns') {
    const rows = options.store?.searchTurns(args.query, { limit: 6, matterId: options.matterId }) ?? []
    return { ok: true, artifact: false, results: rows.map((r) => ({ seq: r.seq, role: r.role, content: r.content.slice(0, 300) })) }
  }
  if (name === 'routine_view') {
    const routine = options.ledger?.listRoutines().find((r) => r.id === args.id && (r.status === 'active' || r.status === 'stale'))
    if (!routine) throw new Error('unknown routine: ' + args.id)
    return { ok: true, artifact: false, routine }
  }
  if (name === 'file_list') {
    const path = policy.resolve(args.dir ?? '.', 'read')
    const entries = await readdir(path, { withFileTypes: true })
    return { ok: true, artifact: false, dir: path, entries: entries.slice(0, 200).map((e) => (e.isDirectory() ? 'd ' : 'f ') + e.name) }
  }
  throw new Error('unknown tool: ' + name)
}

/**
 * Execute one agent tool through the 0.2.3 file policy boundary. Every call
 * is reported to onToolAction (allowed or denied) for the CLI audit chain.
 */
export async function executeTool(name, args = {}, options = {}) {
  const toolArgs = args && typeof args === 'object' ? args : {}
  const policy = createToolPolicy(options)
  const spec = toolPathSpec(name, toolArgs)
  let payload
  try {
    payload = await executeToolInner(name, toolArgs, policy, options)
  } catch (error) {
    await policy.audit({
      tool: name,
      action: spec ? spec.action : 'call',
      input: spec ? spec.input : null,
      allowed: false,
      code: error && typeof error.code === 'string' ? error.code : 'TOOL_ERROR',
      reason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  const path = typeof payload?.path === 'string' ? payload.path : typeof payload?.dir === 'string' ? payload.dir : null
  await policy.audit({
    tool: name,
    action: spec ? spec.action : 'call',
    input: spec ? spec.input : null,
    allowed: true,
    code: 'OK',
    reason: null,
    path,
  })
  return payload
}

const SYSTEM = `You are a work secretary, not a chatbot.
Advisers is a local CLI: \`advisers\` starts the REPL, \`advisers chat "task"\` runs one task, \`advisers status\` shows state, \`advisers office\`/\`advisers template\` build files. It is NOT a directory of consultants; never invent product features.
- Reply in the user's language, BLUF, no filler.
- Use tools to create files only when the user asks for a document/file or the task clearly needs one; otherwise answer in chat. Never claim a file exists unless the tool succeeded.
- For Office work, choose the right builder/template, put deliverables under out/ unless the user says otherwise.
- For Office deliverables, read the file back with office_read and run office_check before claiming completion; report blockers instead of saying done.
- If the request is ambiguous and the answer would change the deliverable, ask one short question instead of guessing.
- Do not invent facts. Keep private matters private.
- Use memory_propose ONLY for a fact stated in the CURRENT user message. Never re-propose facts from earlier turns while answering a question; answer from the existing ledger/history. If an earlier fact is missing, say so plainly instead of trying to backfill it from old messages.
- If you promise to remind or follow up, call commitment_add first; never make an empty promise.
${UNTRUSTED_DATA_RULES}`

function latestReminder(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(now)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')},${get('weekday')},${process.env.ADVISERS_LOCATION || ''},App,中文`
}

function fitMessages(messages, budget) {
  const cap = Math.max(2000, Number(budget) || 12000)
  const estimate = (list) => estimateTokens(list.map((m) => JSON.stringify(m)).join('\n')) + 1500
  let fitted = messages.map((m, i) => (i > 0 && m.role === 'tool' && typeof m.content === 'string' && m.content.length > 4000 ? { ...m, content: truncateUntrusted(m.content, 4000) } : m))
  while (estimate(fitted) > cap && fitted.length > 2) {
    const start = fitted.findIndex((m, i) => i > 0 && m.role === 'user')
    if (start < 0) break
    let end = start + 1
    while (end < fitted.length && fitted[end].role !== 'user') end++
    if (end >= fitted.length) break
    fitted = [...fitted.slice(0, start), ...fitted.slice(end)]
  }
  if (estimate(fitted) > cap) fitted[0] = { ...fitted[0], content: `${String(fitted[0].content).slice(0, cap * 3)}\n[context truncated to budget]` }
  return fitted
}

function stripReasoning(messages) {
  return messages.map((m) => { const copy = { ...m }; delete copy.reasoning_content; return copy })
}

async function callAgentModel(messages, options) {
  try {
    return await chatCompletion({ ...options, messages })
  } catch (error) {
    const body = String(error?.body || '')
    if (error?.status === 400 && /reasoning_content/i.test(body)) {
      const withEmpty = messages.map((m) => m.role === 'assistant' ? { ...m, reasoning_content: m.reasoning_content ?? '' } : m)
      try { return await chatCompletion({ ...options, messages: withEmpty }) } catch (second) {
        if (second?.status === 400 && /reasoning_content/i.test(String(second.body || ''))) {
          return chatCompletion({ ...options, messages: stripReasoning(messages), thinking: false })
        }
        throw second
      }
    }
    throw error
  }
}


const INJECTION_POLICY_ENV = 'ADVISERS_INJECTION_POLICY'
const INJECTION_POLICIES = new Set(['block', 'confirm', 'warn'])
// Untrusted text is scanned at most this much (head + tail) so a multi-MB
// file cannot stall the agent loop; the truncation is a scan-depth bound, not
// a trust promotion (the wrapped payload is still marked untrusted).
const UNTRUSTED_SCAN_CHARS = 100_000
const UNTRUSTED_SCAN_HEAD_CHARS = 60_000
const UNTRUSTED_SCAN_TAIL_CHARS = 40_000

function resolveInjectionPolicy(explicit, env = process.env) {
  const raw = String(explicit == null ? (env?.[INJECTION_POLICY_ENV] ?? 'block') : explicit).trim().toLowerCase()
  return INJECTION_POLICIES.has(raw) ? raw : 'block'
}

function boundedUntrustedScan(text) {
  const raw = String(text == null ? '' : text)
  if (raw.length <= UNTRUSTED_SCAN_CHARS) return raw
  return raw.slice(0, UNTRUSTED_SCAN_HEAD_CHARS) + '\n[untrusted scan gap]\n' + raw.slice(-UNTRUSTED_SCAN_TAIL_CHARS)
}

function safetyWarningFrom(result, direction, source) {
  if (!result || result.action === 'allow') return null
  const injection = result.injection || null
  return {
    direction,
    action: result.action,
    code: result.code,
    severity: result.severity || 'none',
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    categories: Array.isArray(result.categories) ? [...result.categories] : [],
    ruleIds: Array.isArray(result.ruleIds) ? [...result.ruleIds] : [],
    surface: result.surface,
    reason: injection && injection.reason ? injection.reason : result.code,
    source: source || null,
    crisis: Boolean(result.crisis),
    evidenceHash: result.evidenceHash || null,
  }
}

function assessUntrustedText(text, source, safetyKey) {
  const result = classify(boundedUntrustedScan(text), { surface: 'agent.input', hmacKey: safetyKey })
  const injection = result.injection || null
  return {
    result,
    warning: safetyWarningFrom(result, 'untrusted', source),
    highConfidence: Boolean(injection && injection.highConfidence),
    severity: injection ? injection.severity : 'none',
    ruleIds: injection && Array.isArray(injection.ruleIds) ? [...injection.ruleIds] : [],
    reason: injection ? injection.reason : null,
    source: source || null,
  }
}

function normalizeUntrustedEntries(untrusted) {
  const list = Array.isArray(untrusted) ? untrusted : (untrusted == null ? [] : [untrusted])
  const entries = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (item == null) continue
    if (typeof item === 'string') {
      if (item) entries.push({ label: 'untrusted:' + (index + 1), text: item })
      continue
    }
    if (typeof item !== 'object') continue
    const label = item.label || item.source || ('untrusted:' + (index + 1))
    const body = item.text == null ? '' : String(item.text)
    if (body) entries.push({ label: String(label), text: body })
  }
  return entries
}

async function evaluateInjectionGate({ policy, assessments, confirmInjection }) {
  const risky = assessments.filter((assessment) => assessment.highConfidence)
  if (!risky.length || policy === 'warn') return null
  const primary = risky[0]
  const record = {
    code: 'UNTRUSTED_INJECTION',
    severity: primary.severity || 'high',
    ruleIds: [...primary.ruleIds],
    source: primary.source || null,
    reason: primary.reason || 'untrusted content contains instruction-like text',
  }
  if (policy !== 'confirm' || typeof confirmInjection !== 'function') return record
  let allowed = false
  try {
    allowed = Boolean(await confirmInjection({ kind: 'untrusted-injection', ...record }))
  } catch {
    allowed = false
  }
  return allowed ? null : record
}

function blockedAgentResult({ record, warnings, artifacts, toolLog, steps, usage }) {
  const ids = record.ruleIds.length ? record.ruleIds.join(',') : record.code
  return {
    reply: '已阻止：外部内容包含高风险提示注入（' + ids + '），该内容没有发送给模型。请先核实来源；如确需分析这段内容，可用 ADVISERS_INJECTION_POLICY=warn 重试。',
    blocked: true,
    blockReason: record,
    safetyWarnings: warnings,
    artifacts: [...new Set(artifacts)],
    toolLog,
    steps,
    usage,
  }
}

export async function runAgent({
  runtime,
  text,
  context,
  apiKey,
  baseUrl,
  model,
  cwd = process.cwd(),
  workspaceRoot,
  allowPaths,
  maxSteps = 8,
  fetchImpl = fetch,
  onTool,
  onToolAction,
  confirm,
  confirmInjection,
  injectionPolicy,
  force = false,
  backupDir,
  store,
  matterId,
  turnId,
  history = [],
  summary = '',
  ledger,
  thinking,
  effort,
  signal,
  untrusted,
  safetyKey,
}) {
  // The 0.2.2 CLI appends attachments as raw <file> blocks; convert them to the
  // untrusted-data boundary here so the source of the text is explicit even
  // before the CLI migrates to the untrusted[] option.
  const legacy = wrapLegacyAttachmentText(text)
  const inputText = legacy.text
  const userText = legacy.typedText
  const policy = resolveThinking({ task: 'agent', explicit: effort })
  const useThinking = thinking ?? policy.enabled
  const gatePolicy = resolveInjectionPolicy(injectionPolicy)
  const historyBlock = summary ? '\n\n<session-summary>\n' + summary + '\n</session-summary>' : ''
  const warnings = []
  const warningKeys = new Set()
  const pushWarning = (warning) => {
    if (!warning) return
    const key = JSON.stringify([warning.direction, warning.action, warning.code, warning.source, warning.ruleIds])
    if (warningKeys.has(key)) return
    warningKeys.add(key)
    warnings.push(warning)
  }
  // 1. classify untrusted input BEFORE it reaches the model, 2. wrap it so the
  // model sees an explicit data boundary. Typed user text stays trusted; only
  // wrapped blocks and the explicit untrusted[] option are scanned here.
  const pendingAssessments = []
  for (const block of untrustedBlocks(inputText)) {
    pendingAssessments.push(assessUntrustedText(block.text, block.source || 'untrusted', safetyKey))
  }
  const untrustedEntries = normalizeUntrustedEntries(untrusted)
  for (const entry of untrustedEntries) {
    pendingAssessments.push(assessUntrustedText(entry.text, entry.label, safetyKey))
  }
  for (const assessment of pendingAssessments) pushWarning(assessment.warning)
  const dataBlocks = untrustedEntries.map((entry) => wrapUntrusted(entry.label, entry.text)).join('\n\n')
  const messageText = dataBlocks ? inputText + '\n\n' + dataBlocks : inputText
  const messages = [
    { role: 'system', content: SYSTEM + '\n\n' + context.prompt + historyBlock },
    ...history.filter((t) => t.role === (useThinking ? 'user' : t.role)).map((t) => ({ role: t.role, content: t.content })),
    ...(process.env.ADVISERS_LATEST_REMINDER === '0' ? [] : [{ role: 'latest_reminder', content: latestReminder() }]),
    { role: 'user', content: messageText },
  ]
  const artifacts = []
  const toolLog = []
  const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0 }
  for (let step = 0; step < maxSteps; step++) {
    const blockReason = await evaluateInjectionGate({ policy: gatePolicy, assessments: pendingAssessments, confirmInjection })
    pendingAssessments.length = 0
    if (blockReason) return blockedAgentResult({ record: blockReason, warnings, artifacts, toolLog, steps: step, usage })
    const startedAt = Date.now()
    const result = await callAgentModel(fitMessages(messages, process.env.ADVISERS_CONTEXT_TOKENS), { apiKey, baseUrl, model, tools: LOCAL_TOOLS, fetchImpl, task: 'agent', thinking: useThinking, effort, signal })
    if (result.usage) for (const key of Object.keys(usage)) usage[key] += Number(result.usage[key] || 0)
    for (const warning of result.safetyWarnings || []) pushWarning(warning)
    if (result.egressRedaction) {
      pushWarning({
        direction: 'input', action: 'redact', code: 'EGRESS_REDACTED', severity: 'medium', confidence: 1,
        categories: ['pii'], ruleIds: [], surface: 'model.output', reason: '敏感串已在出站前脱敏', source: null,
        crisis: false, evidenceHash: null, redactedCount: result.egressRedaction.count, redactedKinds: result.egressRedaction.kinds,
      })
    }
    try { store?.addModelCall({ task: 'agent', model: result.model || model, effort: result.thinking?.effort, thinking: result.thinking?.enabled !== false, usage: result.usage, durationMs: Date.now() - startedAt, finishReason: result.finishReason, turnId }) } catch {}
    if (!result.toolCalls.length) {
      const done = { reply: result.content.trim(), artifacts: [...new Set(artifacts)], toolLog, steps: step + 1, usage, thinking: result.thinking }
      if (warnings.length) done.safetyWarnings = warnings
      return done
    }
    messages.push({ role: 'assistant', content: result.content, reasoning_content: result.reasoningContent, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      const name = call.function?.name
      const id = call.id ?? ('call_' + randomUUID())
      let payload
      try {
        const args = JSON.parse(call.function?.arguments || '{}')
        onTool?.(name, args)
        const target = writeTarget(name, args, createToolPolicy({ cwd, workspaceRoot, allowPaths }))
        if (target && !force && existsSync(target)) {
          const allowed = confirm ? await confirm({ tool: name, path: target }) : false
          if (!allowed) {
            const declined = { reply: '未覆盖 ' + target + '。如需覆盖，请确认或设置 ADVISERS_FORCE=1。', artifacts: [...new Set(artifacts)], toolLog, declined: true, steps: step + 1 }
            if (warnings.length) declined.safetyWarnings = warnings
            return declined
          }
        }
        payload = await executeTool(name, args, { cwd, workspaceRoot, allowPaths, ledger, backupDir, store, matterId, turnId, userText, onToolAction })
        if (payload.artifact && payload.path) artifacts.push(payload.path)
        if (store && payload.artifact) { try { store.appendAudit({ actor: 'agent', action: 'tool.' + name, allowed: true, reason: payload.path }) } catch {} }
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      toolLog.push({ name, ok: payload.ok !== false, payload })
      // 3. tool results are untrusted data: wrap + classify before the next
      // model call so an injected result can never reach the model unwrapped.
      const payloadText = JSON.stringify(payload)
      const assessment = assessUntrustedText(payloadText, 'tool:' + name, safetyKey)
      pushWarning(assessment.warning)
      if (assessment.highConfidence) pendingAssessments.push(assessment)
      messages.push({ role: 'tool', tool_call_id: id, content: wrapUntrusted('tool:' + name, payloadText) })
    }
  }
  const final = { reply: '任务步骤超过上限，已停止；已完成的部分见文件。', artifacts: [...new Set(artifacts)], toolLog, steps: maxSteps, usage }
  if (warnings.length) final.safetyWarnings = warnings
  return final
}
