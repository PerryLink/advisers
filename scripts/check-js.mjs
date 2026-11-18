#!/usr/bin/env node
/**
 * Static checks for the production JavaScript under packages/.
 *
 * The 0.2.3 architecture audit (T5) recorded "no lint, no JS type checking":
 * 20k lines of production JavaScript were outside tsc/ESLint, so typos, unused
 * parameters, forbidden APIs and secret-material accidents could only be found
 * when a test happened to execute the line. This gate is deliberately small and
 * dependency-free (no ESLint install, no network):
 *
 *   1. syntax      - every file passes `node --check` (parse errors fail CI);
 *   2. no-eval     - no eval() / new Function() / bare Function() string execution;
 *   3. no-shell-exec - no child_process.exec/execSync (shell string interpolation),
 *                      no `shell: true` spawn option;
 *   4. no-secret-material - no obvious hardcoded token/private-key literals
 *                      (AWS/GitHub/npm/OpenAI/Slack/Google/JWT formats, PEM headers);
 *   5. todo markers - count TODO/FIXME/XXX/HACK markers (informational only).
 *
 * Scope: every .js file under packages/*, excluding generated/build output (dist/,
 * node_modules/, coverage/) and test code/fixtures (test/, tests/, fixtures/).
 * Only production files are checked: scripts, docs, tests and dist are out of
 * scope (tests are covered by the test runner itself, dist is generated).
 *
 * Explicit exceptions: add an entry to ALLOWLIST below with the rule id, the
 * exact workspace-relative file path (forward slashes) and a reason. Every
 * exception is printed as INFO so it stays visible in CI output.
 *
 * Usage: node scripts/check-js.mjs
 * Exit:  0 = all rules pass; 1 = at least one violation (or an unreadable file).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')

/** Directory names that are never production source. */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', 'fixtures', '__fixtures__'])
/** Generated/minified file suffixes that are not hand-written source. */
const EXCLUDED_FILE_SUFFIXES = ['.test.js', '.spec.js', '.min.js', '.d.ts']
/** The only file extension this gate covers. */
const SOURCE_EXTENSION = '.js'

/**
 * Explicit, reviewed exceptions. Format:
 *   { rule: '<rule id>', file: 'packages/<pkg>/<path>.js', reason: '<why it is safe>' }
 * Keep this list empty unless an exception is genuinely justified; the point of
 * the gate is to make each exception a visible, reviewed line here.
 */
const ALLOWLIST = []

const RULES = [
  {
    id: 'no-eval',
    description: 'no eval() / new Function() dynamic code execution',
    scan(source, lineAt) {
      const found = []
      for (const re of [/(^|[^.\w$])eval\s*\(/g, /\bnew\s+Function\s*\(/g, /(^|[^.\w$])Function\s*\(/g]) {
        for (const match of source.matchAll(re)) {
          found.push({ line: lineAt(match.index), detail: match[0].trim() })
        }
      }
      return found
    },
  },
  {
    id: 'no-shell-exec',
    description: 'no child_process.exec/execSync or shell:true (argument-array APIs only)',
    scan(source, lineAt) {
      const found = []
      const imports = [
        /(?:import|export)\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/gs,
        /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/gs,
      ]
      for (const re of imports) {
        for (const match of source.matchAll(re)) {
          for (const rawName of String(match[1]).split(',')) {
            const name = rawName.trim().split(/\s+as\s+/)[0]
            if (name === 'exec' || name === 'execSync') {
              found.push({ line: lineAt(match.index), detail: 'imports ' + name + ' from child_process' })
            }
          }
        }
      }
      for (const match of source.matchAll(/(^|[^.\w$])(exec|execSync)\s*\(/g)) {
        found.push({ line: lineAt(match.index), detail: 'calls ' + match[2] + '() (shell string; use execFileSync/spawnSync with an argument array)' })
      }
      for (const match of source.matchAll(/\bshell\s*:\s*true\b/g)) {
        found.push({ line: lineAt(match.index), detail: 'passes shell:true to a child-process call' })
      }
      return found
    },
  },
  {
    id: 'no-secret-material',
    description: 'no hardcoded tokens / private keys',
    scan(source, lineAt) {
      const patterns = [
        [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS access key id'],
        [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, 'GitHub token'],
        [/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm token'],
        [/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'OpenAI-style secret key'],
        [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
        [/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'Google API key'],
        [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT-shaped token'],
        [/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, 'PEM private key header'],
      ]
      const found = []
      for (const [re, label] of patterns) {
        for (const match of source.matchAll(re)) found.push({ line: lineAt(match.index), detail: label })
      }
      return found
    },
  },
]

const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b/g

/** Workspace-relative path with forward slashes (stable in CI logs). */
function relPath(file) {
  return relative(root, file).split('\\').join('/')
}

/** Recursively collect production .js files, skipping generated/test trees. */
function collectSourceFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      collectSourceFiles(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(SOURCE_EXTENSION)) continue
    if (EXCLUDED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    out.push(full)
  }
  return out
}

/**
 * Remove // and block comments while preserving newlines and string bodies, so
 * a rule match is reported at the right line and prose in comments does not
 * trip the rules (a token literal inside a string is still scanned).
 */
function stripComments(source) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 1; continue }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 1; continue }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      out += ch
      continue
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch } else out += ' '
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 1; continue }
      out += ch === '\n' ? '\n' : ' '
      continue
    }
    if (ch === '\\') { out += ch + (source[i + 1] ?? ''); i += 1; continue }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) state = 'code'
    out += ch
  }
  return out
}

function lineNumberLookup(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1)
  return (index) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

function reportRule(id, label, found) {
  if (found.length) {
    console.log('FAIL  ' + id + ': ' + label + ' - ' + found.length + ' violation(s)')
    for (const hit of found) console.log('      ' + hit.file + ': ' + hit.detail)
  } else {
    console.log('PASS  ' + id + ': ' + label)
  }
}

const files = collectSourceFiles(packagesDir)
const violations = []
const info = []

function allowlisted(rule, file) {
  const entry = ALLOWLIST.find((item) => item.rule === rule && item.file === file)
  if (entry) info.push(file + ': ' + rule + ' allowed - ' + entry.reason)
  return Boolean(entry)
}

// Rule 1: syntax. Run the real Node parser per file, so ESM/CJS handling and
// future syntax match what the runtime actually accepts.
let syntaxOk = 0
for (const file of files) {
  const workspacePath = relPath(file)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000 })
    syntaxOk += 1
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim().split('\n').slice(0, 3).join(' ')
    violations.push({ rule: 'syntax', file: workspacePath, detail: 'node --check failed: ' + detail.slice(0, 400) })
  }
}
reportRule('syntax', 'node --check (' + syntaxOk + '/' + files.length + ' files)', violations.filter((v) => v.rule === 'syntax'))

// Rules 2-4: source patterns.
const scanned = []
for (const file of files) {
  const workspacePath = relPath(file)
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    violations.push({ rule: 'read', file: workspacePath, detail: 'cannot read file: ' + String(error.message).slice(0, 200) })
    continue
  }
  scanned.push({ file: workspacePath, raw: source, code: stripComments(source) })
}

for (const rule of RULES) {
  const found = []
  for (const item of scanned) {
    if (allowlisted(rule.id, item.file)) continue
    const lineAt = lineNumberLookup(item.code)
    for (const hit of rule.scan(item.code, lineAt)) {
      found.push({ rule: rule.id, file: item.file, detail: 'line ' + hit.line + ': ' + hit.detail })
    }
  }
  violations.push(...found)
  reportRule(rule.id, rule.description, found)
}

// Rule 5: TODO/FIXME statistics (informational, never fails the build).
const todoFiles = []
let todoTotal = 0
for (const item of scanned) {
  const matches = [...item.raw.matchAll(TODO_RE)]
  if (!matches.length) continue
  todoTotal += matches.length
  const lineAt = lineNumberLookup(item.raw)
  todoFiles.push(item.file + ':' + matches.map((match) => lineAt(match.index)).join(','))
}
if (todoTotal) {
  console.log('INFO  todo-markers: ' + todoTotal + ' TODO/FIXME/XXX/HACK marker(s) in ' + todoFiles.length + ' file(s)')
  for (const entry of todoFiles) console.log('INFO    ' + entry)
} else {
  console.log('INFO  todo-markers: none')
}

if (info.length) console.log('INFO  allowlist: ' + info.length + ' reviewed exception(s)')

const failedCount = violations.length
const filesSummary = files.length + ' production file(s) under packages/*'
if (failedCount) {
  console.error('check-js: FAIL (' + failedCount + ' violation(s) in ' + filesSummary + ')')
  process.exit(1)
}
console.log('check-js: PASS (' + (RULES.length + 1) + ' checks, ' + filesSummary + ')')
