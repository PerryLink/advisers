#!/usr/bin/env node
/**
 * Static host-integration smoke for the three first-wave hosts:
 * Claude Code, DSH (DeepSeek Harness) and Goose.
 *
 * Why "static": a real host install/login is an owner/clean-machine dependency
 * (see docs/AGENT-INTEROP.md section 12). CI has no Claude Code / DSH / Goose
 * binary, so this gate keeps the *contract* honest instead:
 *
 *   1. the CLI entry and the "advisers mcp --stdio" command really exist;
 *   2. the per-host config snippets in docs/AGENT-INTEROP.md (and docs/MCP.md
 *      for Claude Code) match the shipped command, and optional host config
 *      files can be checked with --claude-config / --goose-config / --dsh-config;
 *   3. the DSH bundle manifest is complete (dsh.bundle.patch, engines,
 *      dependency pins, files allowlist) and registers exactly six tools;
 *   4. the corrected DSH catalog facts and the submission entry draft are
 *      present, so the old "catalog 0 hits" wording cannot come back.
 *
 * A PASS here is NOT a real-host verification and must never be quoted as one.
 * The script reads files only: no network, no host binary, no HOME/ledger write.
 *
 * Usage:
 *   node scripts/host-smoke.mjs                       static checks for all three hosts
 *   node scripts/host-smoke.mjs --json                machine-readable result
 *   node scripts/host-smoke.mjs --host claude         one host (claude|goose|dsh)
 *   node scripts/host-smoke.mjs --claude-config <f>   also check a .mcp.json
 *   node scripts/host-smoke.mjs --goose-config <f>    also check a Goose config.yaml
 *   node scripts/host-smoke.mjs --dsh-config <f>      also check dsh --dump-config output
 *   node scripts/host-smoke.mjs --dsh-version 0.2.3-alpha.2
 *   node scripts/host-smoke.mjs --print-config <host> print a paste-ready snippet
 *   node scripts/host-smoke.mjs --self-test           offline detector fixtures
 *
 * Exit codes: 0 = every check passed or was honestly skipped, 1 = a check
 * failed, 2 = usage error.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')
const readIf = (file) => (existsSync(join(root, file)) ? read(file) : '')
const json = (file) => JSON.parse(read(file))

const ADVISERS_PKG = 'packages/advisers/package.json'
const DSH_PKG = 'packages/dsh-advisers/package.json'
const DSH_PATCH = 'packages/dsh-advisers/cordis.patch.yml'
const DSH_INDEX = 'packages/dsh-advisers/index.js'
const INTEROP_DOC = 'docs/AGENT-INTEROP.md'
const MCP_DOC = 'docs/MCP.md'

const DSH_TOOLS = ['advisers_brief', 'advisers_office', 'advisers_today', 'advisers_who', 'advisers_evidence', 'advisers_clients']
const HOSTS = ['claude', 'goose', 'dsh']

const checks = []
function record(host, id, status, detail) {
  checks.push({ host, id, status, detail: String(detail || '') })
}
const pass = (host, id, detail) => record(host, id, 'PASS', detail)
const fail = (host, id, detail) => record(host, id, 'FAIL', detail)
const skip = (host, id, detail) => record(host, id, 'SKIP', detail)
const warn = (host, id, detail) => record(host, id, 'WARN', detail)
function check(host, id, ok, good, bad) {
  if (ok) pass(host, id, good)
  else fail(host, id, bad)
}

// ---------------------------------------------------------------------------
// Semver subset (enough for engines.dsh: ">=0.2.1-rc.5 <0.3.0")
// ---------------------------------------------------------------------------
export function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) === Number(right) ? 0 : Number(left) < Number(right) ? -1 : 1
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= a.pre.length) return -1
    if (index >= b.pre.length) return 1
    const result = compareIdentifier(a.pre[index], b.pre[index])
    if (result !== 0) return result
  }
  return 0
}

/** True when version satisfies a simple space-separated comparator range. */
export function satisfies(version, range) {
  const tokens = String(range || '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  for (const token of tokens) {
    if (token === '*' || token === 'x') continue
    const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token)
    if (!match) return false
    const operator = match[1] || '='
    const compared = compareVersions(version, match[2])
    if (compared === null) return false
    if (operator === '>=' && !(compared >= 0)) return false
    if (operator === '<=' && !(compared <= 0)) return false
    if (operator === '>' && !(compared > 0)) return false
    if (operator === '<' && !(compared < 0)) return false
    if (operator === '=' && compared !== 0) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Goose config.yaml subset parser (extensions.<name>.type/cmd/args/enabled).
// The real file is a user file; this only reads the keys we ship in the docs.
// ---------------------------------------------------------------------------
function splitInlineList(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

export function parseGooseYaml(text) {
  const result = { ok: true, error: null, entries: {} }
  const lines = String(text || '').split(/\r?\n/)
  let inExtensions = false
  let current = null
  let currentArrayKey = null
  for (const rawLine of lines) {
    const noComment = rawLine.replace(/\s+#.*$/, '')
    if (!noComment.trim()) continue
    const indent = noComment.length - noComment.trimStart().length
    const line = noComment.trim()
    if (indent === 0) {
      inExtensions = line === 'extensions:'
      current = null
      currentArrayKey = null
      continue
    }
    if (!inExtensions) continue
    const entryName = /^([A-Za-z0-9_.@-]+):\s*$/.exec(line)
    if (indent === 2 && entryName) {
      current = entryName[1]
      result.entries[current] = { name: current, args: [] }
      currentArrayKey = null
      continue
    }
    if (!current) continue
    const entry = result.entries[current]
    if (indent === 4) {
      const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (!pair) continue
      const key = pair[1]
      const value = pair[2].trim()
      if (key === 'args') {
        const list = splitInlineList(value)
        if (list) {
          entry.args = list
          currentArrayKey = null
        } else {
          currentArrayKey = 'args'
        }
      } else if (value === '') {
        currentArrayKey = key
      } else {
        entry[key] = value.replace(/^["']|["']$/g, '')
        currentArrayKey = null
      }
      continue
    }
    if (indent === 6 && currentArrayKey === 'args' && /^-\s+/.test(line)) {
      entry.args.push(line.replace(/^-\s+/, '').replace(/^["']|["']$/g, ''))
    }
  }
  return result
}

export function findGooseEntry(parsed) {
  const entries = Object.values(parsed.entries)
  const byName = entries.find((entry) => entry.name === 'advisers')
  if (byName) return byName
  return entries.find((entry) => /advisers/i.test(String(entry.cmd || '')) || entry.args.some((arg) => /advisers/i.test(arg))) || null
}

export function validateGooseEntry(entry) {
  const problems = []
  if (!entry) return { ok: false, problems: ['no advisers extension entry'] }
  if (String(entry.type || '') !== 'stdio') problems.push('type must be stdio')
  const cmd = String(entry.cmd || '')
  if (!(cmd === 'advisers' || /advisers(\.js|\.mjs)?$/.test(cmd))) problems.push('cmd must resolve to the advisers CLI')
  if (!entry.args.includes('mcp')) problems.push('args must include mcp')
  if (!entry.args.includes('--stdio')) problems.push('args must include --stdio')
  if (entry.enabled !== undefined && String(entry.enabled).toLowerCase() === 'false') problems.push('extension is disabled')
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// Claude Code .mcp.json validator
// ---------------------------------------------------------------------------
export function validateClaudeConfig(value) {
  const servers = value && (value.mcpServers || value.mcp_servers)
  if (!servers || typeof servers !== 'object') return { ok: false, detail: 'no mcpServers object', name: null }
  const candidates = Object.entries(servers).filter(([name, config]) => {
    const text = JSON.stringify(config || {}).toLowerCase()
    return /advisers/i.test(name) || text.includes('advisers')
  })
  if (candidates.length === 0) return { ok: false, detail: 'no advisers entry in mcpServers', name: null }
  const [name, config] = candidates[0]
  const command = String((config && config.command) || '')
  const args = Array.isArray(config && config.args) ? config.args.map(String) : []
  const problems = []
  if (!(command === 'advisers' || /advisers(\.js|\.mjs)?$/.test(command))) problems.push('command must resolve to the advisers CLI')
  if (!args.includes('mcp')) problems.push('args must include mcp')
  if (!args.includes('--stdio')) problems.push('args must include --stdio')
  return { ok: problems.length === 0, detail: problems.join('; ') || 'ok', name }
}

// ---------------------------------------------------------------------------
// Docs helpers: pull a section, then a fenced block from it.
// ---------------------------------------------------------------------------
function docSection(text, heading) {
  const index = text.indexOf(heading)
  if (index === -1) return ''
  const rest = text.slice(index + heading.length)
  const next = rest.search(/^##\s/m)
  return next === -1 ? rest : rest.slice(0, next)
}

const FENCE = String.fromCharCode(96, 96, 96)

function fencedBlock(section, info) {
  const pattern = new RegExp('^' + FENCE + (info || '') + '[^\\n]*\\n([\\s\\S]*?)\\n' + FENCE, 'm')
  const match = pattern.exec(section)
  return match ? match[1] : ''
}

// ---------------------------------------------------------------------------
// Catalog regression detector: the corrected facts must exist and the old
// "catalog 0 hits" / "12,961 as index count" wording must not come back.
// ---------------------------------------------------------------------------
export function catalogProblems(text) {
  const problems = []
  const body = String(text || '')
  if (!/(6,?808)/.test(body)) problems.push('missing corrected index count 6,808')
  if (!/\b159\b/.test(body)) problems.push('missing corrected PerryLink entry count 159')
  if (!/PerryLink/.test(body)) problems.push('missing PerryLink publisher fact')
  if (!/dsh-famling/.test(body)) problems.push('missing dsh-famling cross-reference fact')
  if (!/dsh-advisers/.test(body)) problems.push('missing dsh-advisers entry fact')
  if (/0\s*listing/i.test(body)) problems.push('stale "0 listing" claim')
  if (/catalog[^.\n]{0,40}0\s*命中/.test(body)) problems.push('stale catalog-0-hits claim')
  if (/12,?961/.test(body)) problems.push('stale 12,961-as-index-count wording')
  return problems
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------
function checkRepoBasics() {
  check('claude', 'repo.advisers-package', existsSync(join(root, ADVISERS_PKG)), ADVISERS_PKG + ' present', ADVISERS_PKG + ' missing')
  check('dsh', 'repo.dsh-bundle-dir', existsSync(join(root, 'packages/dsh-advisers')), 'packages/dsh-advisers present', 'packages/dsh-advisers missing')
  check('claude', 'repo.interop-doc', existsSync(join(root, INTEROP_DOC)), INTEROP_DOC + ' present', INTEROP_DOC + ' missing')
  check('claude', 'repo.mcp-doc', existsSync(join(root, MCP_DOC)), MCP_DOC + ' present', MCP_DOC + ' missing')
}

function checkNodeEngine(advisersPkg, host) {
  const range = String((advisersPkg.engines && advisersPkg.engines.node) || '')
  check(host, 'node.engine-declared', range !== '', 'engines.node=' + range, 'engines.node is not declared')
  if (!range) return
  check(host, 'node.engine-satisfied-by-this-run', satisfies(process.versions.node, range), 'Node ' + process.versions.node + ' satisfies ' + range, 'Node ' + process.versions.node + ' does not satisfy ' + range)
}

function checkClaude(advisersPkg, options) {
  const cliPath = 'packages/advisers/bin/advisers.js'
  check('claude', 'claude.cli-entry', existsSync(join(root, cliPath)), cliPath + ' present', cliPath + ' missing')
  const bin = advisersPkg.bin && advisersPkg.bin.advisers
  check('claude', 'claude.bin-field', bin === './bin/advisers.js', 'package bin maps advisers -> ./bin/advisers.js', 'unexpected bin field: ' + String(bin))
  const cli = readIf(cliPath)
  check('claude', 'claude.mcp-stdio', /advisers mcp --stdio/.test(cli) && cli.includes("includes('--stdio')"), 'CLI advertises and dispatches advisers mcp --stdio', 'CLI has no working mcp --stdio entry')
  const doc = readIf(INTEROP_DOC)
  const claudeSection = docSection(doc, '## 2. Claude Code')
  check('claude', 'claude.doc-section', claudeSection !== '', 'AGENT-INTEROP has a Claude Code section', 'AGENT-INTEROP section missing')
  check('claude', 'claude.doc-cli-command', /claude mcp add advisers -- advisers mcp --stdio/.test(claudeSection), 'documented claude mcp add one-liner', 'missing the claude mcp add one-liner')
  const claudeJson = fencedBlock(claudeSection, 'json')
  let snippetOk = false
  if (claudeJson) {
    try {
      snippetOk = validateClaudeConfig(JSON.parse(claudeJson)).ok
    } catch {
      snippetOk = false
    }
  }
  check('claude', 'claude.doc-json-snippet', snippetOk, 'documented .mcp.json snippet is valid and points at the stdio server', 'documented .mcp.json snippet is missing or invalid')
  check('claude', 'claude.mcp-doc-crosslink', readIf(MCP_DOC).includes('advisers mcp --stdio'), 'MCP.md documents the same stdio command', 'MCP.md does not document advisers mcp --stdio')
  if (options.claudeConfig) {
    const target = options.claudeConfig
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'))
    } catch (error) {
      fail('claude', 'claude.config-file', 'cannot parse ' + target + ': ' + String(error && error.message))
      return
    }
    const result = validateClaudeConfig(parsed)
    check('claude', 'claude.config-file', result.ok, 'config ' + target + ' registers the advisers stdio server', 'config ' + target + ': ' + result.detail)
  } else {
    skip('claude', 'claude.config-file', 'no --claude-config given (optional; no host install needed)')
  }
}

function checkGoose(advisersPkg, options) {
  const doc = readIf(INTEROP_DOC)
  const gooseSection = docSection(doc, '## 6. Goose')
  check('goose', 'goose.doc-section', gooseSection !== '', 'AGENT-INTEROP has a Goose section', 'AGENT-INTEROP section missing')
  const yamlBlock = fencedBlock(gooseSection, 'yaml')
  check('goose', 'goose.doc-yaml-block', yamlBlock !== '', 'documented config.yaml block present', 'documented config.yaml block missing')
  if (yamlBlock) {
    const parsed = parseGooseYaml(yamlBlock)
    const entry = findGooseEntry(parsed)
    const result = validateGooseEntry(entry)
    check('goose', 'goose.doc-entry', result.ok, 'documented Goose extension is stdio -> advisers mcp --stdio', 'documented Goose extension invalid: ' + result.problems.join('; '))
  }
  check('goose', 'goose.bin-name', (advisersPkg.bin && advisersPkg.bin.advisers) === './bin/advisers.js', 'advisers on PATH is the supported cmd', 'package bin does not provide the advisers command')
  if (options.gooseConfig) {
    const target = options.gooseConfig
    let text = ''
    try {
      text = readFileSync(target, 'utf8')
    } catch (error) {
      fail('goose', 'goose.config-file', 'cannot read ' + target + ': ' + String(error && error.message))
      return
    }
    const entry = findGooseEntry(parseGooseYaml(text))
    const result = validateGooseEntry(entry)
    check('goose', 'goose.config-file', result.ok, 'config ' + target + ' registers the advisers stdio extension', 'config ' + target + ': ' + result.problems.join('; '))
  } else {
    skip('goose', 'goose.config-file', 'no --goose-config given (optional; no host install needed)')
  }
}

function checkDsh(options) {
  check('dsh', 'dsh.package', existsSync(join(root, DSH_PKG)), DSH_PKG + ' present', DSH_PKG + ' missing')
  if (!existsSync(join(root, DSH_PKG))) return
  const pkg = json(DSH_PKG)
  const advisersPkg = json(ADVISERS_PKG)
  const corePkg = json('packages/core/package.json')
  const officePkg = json('packages/office/package.json')
  check('dsh', 'dsh.name', pkg.name === 'dsh-advisers', 'package name dsh-advisers', 'unexpected package name: ' + String(pkg.name))
  check('dsh', 'dsh.version-lockstep', pkg.version === advisersPkg.version, 'lockstep version ' + String(pkg.version), 'version ' + String(pkg.version) + ' != advisers ' + String(advisersPkg.version))
  const patchPath = String((pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) || '')
  check('dsh', 'dsh.bundle-manifest', patchPath === './cordis.patch.yml', 'dsh.bundle.patch=./cordis.patch.yml', 'dsh.bundle.patch missing or unexpected: ' + patchPath)
  const patch = readIf(DSH_PATCH)
  check('dsh', 'dsh.patch-file', existsSync(join(root, DSH_PATCH)), DSH_PATCH + ' present', DSH_PATCH + ' missing')
  check('dsh', 'dsh.patch-content', /- insert:/.test(patch) && /id:\s*advisers/.test(patch) && /name:\s*dsh-advisers/.test(patch), 'patch inserts id: advisers / name: dsh-advisers', 'patch is missing the insert/id/name fields')
  check('dsh', 'dsh.engines-node', /^>=\d+\.\d+/.test(String((pkg.engines && pkg.engines.node) || '')), 'engines.node=' + String(pkg.engines && pkg.engines.node), 'engines.node missing')
  const dshRange = String((pkg.engines && pkg.engines.dsh) || '')
  check('dsh', 'dsh.engines-dsh', dshRange !== '', 'engines.dsh=' + dshRange, 'engines.dsh missing')
  if (options.dshVersion) {
    check('dsh', 'dsh.version-satisfies-engine', satisfies(options.dshVersion, dshRange), 'DSH ' + options.dshVersion + ' satisfies ' + dshRange, 'DSH ' + options.dshVersion + ' does not satisfy ' + dshRange)
  } else {
    skip('dsh', 'dsh.version-satisfies-engine', 'no --dsh-version given (no DSH binary required for the static check)')
  }
  const deps = pkg.dependencies || {}
  check('dsh', 'dsh.dependency-advisers', deps.advisers === advisersPkg.version, 'advisers dep pinned to ' + String(advisersPkg.version), 'advisers dep mismatch: ' + String(deps.advisers))
  check('dsh', 'dsh.dependency-core', deps['advisers-core'] === corePkg.version, 'advisers-core dep pinned to ' + String(corePkg.version), 'advisers-core dep mismatch: ' + String(deps['advisers-core']))
  check('dsh', 'dsh.dependency-office', deps['advisers-office'] === officePkg.version, 'advisers-office dep pinned to ' + String(officePkg.version), 'advisers-office dep mismatch: ' + String(deps['advisers-office']))
  check('dsh', 'dsh.dependency-dsh-tools', Boolean(deps['@deepseek-ai/dsh-tools']), 'dsh-tools dependency pin present', 'dsh-tools dependency pin missing')
  const peer = pkg.peerDependencies || {}
  check('dsh', 'dsh.peer-deps', Boolean(peer['@deepseek-ai/cordis']) && Boolean(peer['@deepseek-ai/dsh-tools']), 'cordis/dsh-tools peer deps present', 'peer deps missing')
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const requiredFiles = ['index.js', 'lib', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']
  const missingFiles = requiredFiles.filter((file) => !files.includes(file))
  check('dsh', 'dsh.files-allowlist', missingFiles.length === 0, 'tarball files allowlist complete', 'files missing: ' + missingFiles.join(', '))
  const index = readIf(DSH_INDEX)
  check('dsh', 'dsh.index-version', index.includes("export const version = '" + String(pkg.version) + "'"), 'index.js version constant matches package.json', 'index.js version constant mismatch')
  const toolNames = []
  const re = /name:\s*'(advisers_[a-z_]+)'/g
  let match = re.exec(index)
  while (match) {
    if (!toolNames.includes(match[1])) toolNames.push(match[1])
    match = re.exec(index)
  }
  const missingTools = DSH_TOOLS.filter((tool) => !toolNames.includes(tool))
  const extraTools = toolNames.filter((tool) => !DSH_TOOLS.includes(tool))
  check('dsh', 'dsh.tool-count', missingTools.length === 0 && extraTools.length === 0 && toolNames.length === DSH_TOOLS.length, 'exactly six tool registrations: ' + DSH_TOOLS.join(', '), 'tool mismatch; found=' + toolNames.join(', '))
  const doc = readIf(INTEROP_DOC)
  const dshSection = docSection(doc, '## 8. DSH (DeepSeek Harness)')
  const missingDocTools = DSH_TOOLS.filter((tool) => !dshSection.includes(tool))
  check('dsh', 'dsh.doc-tools', missingDocTools.length === 0, 'AGENT-INTEROP section 8 documents all six tools', 'AGENT-INTEROP section 8 misses: ' + missingDocTools.join(', '))
  check('dsh', 'dsh.doc-install', /dsh plugin --profile main add dsh-advisers advisers-core/.test(doc), 'AGENT-INTEROP documents the bundle install command', 'AGENT-INTEROP install command missing')
  check('dsh', 'dsh.doc-audit-honesty', /audited:false/.test(dshSection), 'AGENT-INTEROP keeps the audited:false honesty note', 'audited:false note missing')
  const dshReadme = readIf('packages/dsh-advisers/README.md')
  check('dsh', 'dsh.readme-install', /dsh plugin --profile main add dsh-advisers advisers-core/.test(dshReadme), 'bundle README documents the install command', 'bundle README install command missing')
  if (options.dshConfig) {
    const target = options.dshConfig
    let text = ''
    try {
      text = readFileSync(target, 'utf8')
    } catch (error) {
      fail('dsh', 'dsh.config-file', 'cannot read ' + target + ': ' + String(error && error.message))
      return
    }
    check('dsh', 'dsh.config-file', text.includes('dsh-advisers'), 'dump-config output ' + target + ' mentions dsh-advisers', 'dump-config output ' + target + ' does not mention dsh-advisers')
  } else {
    skip('dsh', 'dsh.config-file', 'no --dsh-config given (optional; no DSH install needed)')
  }
  const catalogSection = docSection(doc, '## 13. DSH discovery')
  const problems = catalogProblems(catalogSection)
  check('dsh', 'dsh.catalog-facts', catalogSection !== '' && problems.length === 0, 'corrected DSH catalog facts present (6,808 index plugins / 159 PerryLink / dsh-advisers missing / dsh-famling cross-ref)', 'catalog section missing or stale: ' + problems.join('; '))
  check('dsh', 'dsh.catalog-entry-draft', catalogSection.includes('data/plugins/PerryLink__advisers--packages-dsh-advisers.yml'), 'submission entry path draft present', 'submission entry path draft missing')
  check('dsh', 'dsh.catalog-pr-text', /category:\s*workflow/.test(catalogSection) && /description:\s*/.test(catalogSection), 'entry draft has category and description fields', 'entry draft fields missing')
}

// ---------------------------------------------------------------------------
// Paste-ready snippets (kept in sync by the docs checks above).
// ---------------------------------------------------------------------------
const CONFIG_SNIPPETS = {
  claude: [
    '# Claude Code (MCP stdio, local process)',
    '# 1) CLI one-liner',
    'claude mcp add advisers -- advisers mcp --stdio',
    '# 2) project .mcp.json',
    '{',
    '  "mcpServers": {',
    '    "advisers": { "command": "advisers", "args": ["mcp", "--stdio"] }',
    '  }',
    '}',
  ].join('\n'),
  goose: [
    '# Goose config.yaml (~/.config/goose/config.yaml on Linux/macOS; check the host docs on Windows)',
    'extensions:',
    '  advisers:',
    '    name: advisers',
    '    type: stdio',
    '    cmd: advisers',
    '    args: ["mcp", "--stdio"]',
    '    enabled: true',
    '    timeout: 300',
  ].join('\n'),
  dsh: [
    '# DSH 0.2.3-alpha.2: first-party bundle, no official third-party marketplace',
    'dsh plugin --profile main add dsh-advisers advisers-core',
    'dsh --profile main --dump-config   # should show a "# == dsh-advisers" layer',
    '# upgrade / rollback: re-run the add with an exact version, or remove it and add the pinned version',
    '# (non-official entries have no host-side auto-update; do not claim an official-market listing)',
  ].join('\n'),
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function usage() {
  return [
    'usage: node scripts/host-smoke.mjs [--json] [--host claude|goose|dsh]',
    '       [--claude-config <file>] [--goose-config <file>] [--dsh-config <file>]',
    '       [--dsh-version <version>] [--print-config <claude|goose|dsh>] [--self-test]',
    '',
    'Static host-integration checks. Reads files only: no network, no host binary,',
    'no HOME/ledger write. A PASS is not a real-host verification.',
    '',
    'exit: 0 = pass/skip, 1 = fail, 2 = usage error',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    json: false,
    host: null,
    claudeConfig: null,
    gooseConfig: null,
    dshConfig: null,
    dshVersion: null,
    printConfig: null,
    selfTest: false,
    help: false,
  }
  const valueOptions = new Map([
    ['--claude-config', 'claudeConfig'],
    ['--goose-config', 'gooseConfig'],
    ['--dsh-config', 'dshConfig'],
    ['--dsh-version', 'dshVersion'],
    ['--print-config', 'printConfig'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--host') {
      const value = argv[index + 1]
      if (!HOSTS.includes(value)) return { error: '--host expects claude|goose|dsh' }
      options.host = value
      index += 1
    } else if (valueOptions.has(arg)) {
      const value = argv[index + 1]
      if (!value) return { error: arg + ' expects a value' }
      options[valueOptions.get(arg)] = value
      index += 1
    } else {
      return { error: 'unknown option: ' + arg }
    }
  }
  if (options.printConfig && !HOSTS.includes(options.printConfig)) return { error: '--print-config expects claude|goose|dsh' }
  if (options.printConfig && options.json) return { error: '--print-config and --json are mutually exclusive' }
  return { options }
}

function runSelfTest() {
  const fixtures = []
  fixtures.push(['semver accepts 0.2.3-alpha.2 in engines.dsh', () => satisfies('0.2.3-alpha.2', '>=0.2.1-rc.5 <0.3.0') === true])
  fixtures.push(['semver rejects 0.3.0 for engines.dsh', () => satisfies('0.3.0', '>=0.2.1-rc.5 <0.3.0') === false])
  fixtures.push(['semver compares prereleases', () => compareVersions('0.2.1-rc.4', '0.2.1-rc.5') === -1])
  fixtures.push(['goose inline args parse', () => {
    const parsed = parseGooseYaml('extensions:\n  advisers:\n    type: stdio\n    cmd: advisers\n    args: ["mcp", "--stdio"]\n    enabled: true\n')
    return validateGooseEntry(findGooseEntry(parsed)).ok === true
  }])
  fixtures.push(['goose block args parse', () => {
    const parsed = parseGooseYaml('extensions:\n  advisers:\n    type: stdio\n    cmd: advisers\n    args:\n      - mcp\n      - --stdio\n    enabled: true\n')
    return validateGooseEntry(findGooseEntry(parsed)).ok === true
  }])
  fixtures.push(['goose missing --stdio fails', () => {
    const parsed = parseGooseYaml('extensions:\n  advisers:\n    type: stdio\n    cmd: advisers\n    args: ["mcp"]\n')
    return validateGooseEntry(findGooseEntry(parsed)).ok === false
  }])
  fixtures.push(['claude config validator', () => validateClaudeConfig({ mcpServers: { advisers: { command: 'advisers', args: ['mcp', '--stdio'] } } }).ok === true && validateClaudeConfig({ mcpServers: {} }).ok === false])
  fixtures.push(['catalog regression detector', () => {
    const good = 'index.json: 6,808 plugins; 159 PerryLink entries; dsh-famling cross-reference; dsh-advisers has no entry.'
    const bad = 'catalog 0 命中; 0 listing'
    return catalogProblems(good).length === 0 && catalogProblems(bad).length > 0
  }])
  let failed = 0
  for (const [name, run] of fixtures) {
    let ok = false
    try {
      ok = run() === true
    } catch {
      ok = false
    }
    if (!ok) failed += 1
    console.log((ok ? 'PASS' : 'FAIL') + ' self-test :: ' + name)
  }
  console.log('')
  console.log((failed === 0 ? 'PASS' : 'FAIL') + ' host-smoke self-test (' + fixtures.length + ' fixtures)')
  return failed === 0 ? 0 : 1
}

function main() {
  const parsedArgs = parseArgs(process.argv.slice(2))
  if (parsedArgs.error) {
    console.error('host-smoke: ' + parsedArgs.error)
    console.error(usage())
    process.exit(2)
  }
  const options = parsedArgs.options
  if (options.help) {
    console.log(usage())
    process.exit(0)
  }
  if (options.selfTest) process.exit(runSelfTest())
  if (options.printConfig) {
    console.log(CONFIG_SNIPPETS[options.printConfig])
    process.exit(0)
  }

  const advisersPkg = json(ADVISERS_PKG)
  checkRepoBasics()
  checkNodeEngine(advisersPkg, 'claude')
  const shouldRun = (host) => options.host === null || options.host === host
  if (shouldRun('claude')) checkClaude(advisersPkg, options)
  if (shouldRun('goose')) checkGoose(advisersPkg, options)
  if (shouldRun('dsh')) checkDsh(options)

  const summary = { pass: 0, fail: 0, skip: 0, warn: 0 }
  for (const item of checks) {
    if (item.status === 'PASS') summary.pass += 1
    else if (item.status === 'FAIL') summary.fail += 1
    else if (item.status === 'SKIP') summary.skip += 1
    else summary.warn += 1
  }
  const ok = summary.fail === 0
  if (options.json) {
    console.log(JSON.stringify({ ok, generatedAt: new Date().toISOString(), hosts: options.host ? [options.host] : HOSTS, checks, summary }, null, 2))
  } else {
    for (const item of checks) {
      const detail = item.detail ? ' — ' + item.detail : ''
      console.log(item.status + ' ' + item.id + detail)
    }
    console.log('')
    console.log((ok ? 'PASS' : 'FAIL') + ' host-smoke (' + summary.pass + ' PASS, ' + summary.skip + ' SKIP, ' + summary.warn + ' WARN, ' + summary.fail + ' FAIL)')
    console.log('Note: static checks only; this is not a real-host verification (see docs/AGENT-INTEROP.md section 12).')
  }
  process.exit(ok ? 0 : 1)
}

main()
