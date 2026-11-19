#!/usr/bin/env node
/**
 * Interface contract gate (Advisers 0.3.0).
 *
 * Validates that the machine-readable contracts under contracts/ stay in sync
 * with the real CLI/MCP code and with the docs, without a network, credentials
 * or a model. It ships its own strict JSON-Schema-subset validator (unknown
 * keywords fail closed) instead of adding ajv to the workspace.
 *
 * Checks (all run by default; select with flags):
 *   --schema   every contracts/**\/*.schema.json parses, carries the required
 *              metadata ($schema/$id/version/x-license/x-*), uses only the
 *              supported keyword subset and has resolvable local $refs; every
 *              other contracts/**\/*.json parses.
 *   --vectors  every vectors file points at an existing schema, covers every
 *              top-level $def of that schema, has at least 3 accept/reject cases
 *              and every case validates (or fails to validate) as declared.
 *   --cli      runs the deterministic --json commands from cli/commands-v1.json
 *              against the real CLI in a temporary ADVISERS_HOME; stdout is pure
 *              JSON and every payload matches its frozen $def.
 *   --status   "advisers status --json" works on a fresh home with no TOS
 *              acceptance and no credentials, matches StatusPayload, and the
 *              additive status.contracts discovery field (when present) equals
 *              versions-v1.json discovery.expected.
 *   --exit     runs the exit-code probes from cli/exit-codes-v1.json and checks
 *              the observed process exit codes, stdout/stderr shapes and the
 *              frozen error envelope.
 *   --mcp      starts one real "advisers mcp --stdio" session and validates
 *              initialize / tools/list / resources/list / resources/read /
 *              tools/call / JSON-RPC errors against mcp/*.json and
 *              mcp/responses-v1.schema.json.
 *   --errors   committed source literals in packages/advisers/{bin,lib} are a
 *              subset of the registry; registry codes exist in committed or
 *              working-tree source (0.3.0 entries may be registered ahead of
 *              their module commit); contracts/errors/codes.v1.json and
 *              docs/ERROR-CODES.md equal the generated output; exit mapping and
 *              DSH external codes are intact.
 *   --docs     docs/CONTRACTS.md mentions every artifact in versions-v1.json and
 *              the discovery manifest agrees with the artifact versions.
 *
 * --update regenerates contracts/errors/codes.v1.json and docs/ERROR-CODES.md
 * from packages/advisers/lib/error-codes.js (then still runs the selected
 * checks). This is the only intended writer for those two generated files.
 *
 * Exit: 0 = all selected checks pass; 1 = at least one failure (or a usage
 * error). Everything is read-only except --update and the temporary
 * ADVISERS_HOME directories under os.tmpdir(), which are removed afterwards.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ERROR_CODES,
  ERROR_CODE_LIST,
  ERROR_CATEGORIES,
  ERROR_SURFACES,
  ERROR_CODE_VERSION,
  ERROR_CODES_FROZEN_AT,
  ERROR_CODES_SOURCE_COMMIT,
  ERROR_CODES_SOURCE_VERSION,
  ERROR_CODES_BASELINE_COUNT,
  ERROR_CODES_RELEASE,
  DSH_ERROR_CODES,
} from '../packages/advisers/lib/error-codes.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const contractsDir = join(root, 'contracts')
const docsDir = join(root, 'docs')
const binPath = join(root, 'packages/advisers/bin/advisers.js')
const cliPkgPath = join(root, 'packages/advisers/package.json')
const registryPath = join(contractsDir, 'errors/codes.v1.json')
const errorDocsPath = join(docsDir, 'ERROR-CODES.md')
const contractsDocsPath = join(docsDir, 'CONTRACTS.md')
const dshIndexPath = join(root, 'packages/dsh-advisers/index.js')
const petBriefSchemaPath = join(docsDir, 'pet-brief/schema-v0.2.json')
const GITHUB_CONTRACTS = 'https://github.com/PerryLink/advisers/contracts'
const TEST_TIMEOUT_MS = 120000

const ALL_CHECKS = ['schema', 'vectors', 'cli', 'status', 'exit', 'mcp', 'errors', 'docs']
const CHECK_FLAGS = {
  '--schema': 'schema',
  '--vectors': 'vectors',
  '--cli': 'cli',
  '--status': 'status',
  '--exit': 'exit',
  '--mcp': 'mcp',
  '--errors': 'errors',
  '--docs': 'docs',
}

/* ------------------------------------------------------------------ */
/* output bookkeeping                                                  */
/* ------------------------------------------------------------------ */

let passCount = 0
let infoCount = 0
const failures = []

function pass(name, detail) {
  passCount += 1
  console.log('PASS ' + name + (detail ? ' (' + detail + ')' : ''))
}

function fail(name, detail) {
  const message = name + (detail ? ': ' + detail : '')
  failures.push(message)
  console.log('FAIL ' + name + (detail ? ' — ' + detail : ''))
}

function info(message) {
  infoCount += 1
  console.log('INFO ' + message)
}

function firstErrors(errors, limit = 3) {
  const shown = errors.slice(0, limit).join('; ')
  return errors.length > limit ? shown + '; +' + (errors.length - limit) + ' more' : shown
}

/* ------------------------------------------------------------------ */
/* small fs/json helpers                                               */
/* ------------------------------------------------------------------ */

const readText = (file) => readFileSync(file, 'utf8')
const readJson = (file) => JSON.parse(readText(file))
const relOf = (file) => relative(root, file).split(sep).join('/')

function writeGenerated(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  console.log('WROTE ' + relOf(file))
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, predicate, out)
    else if (predicate(full)) out.push(full)
  }
  return out
}

function tempWorkspace(label) {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-contracts-' + label + '-'))
  const home = join(dir, 'home')
  const work = join(dir, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { dir, home, work }
}

function cleanupWorkspace(space) {
  try {
    rmSync(space.dir, { recursive: true, force: true })
  } catch {
    /* best effort: the OS temp cleaner also removes it */
  }
}

/* ------------------------------------------------------------------ */
/* strict JSON-Schema subset validator                                 */
/* ------------------------------------------------------------------ */

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'minItems', 'maxItems', 'oneOf', 'anyOf', 'allOf', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly', 'version',
])

const REQUIRED_SCHEMA_METADATA = [
  '$schema', '$id', 'title', 'description', 'version',
  'x-license', 'x-contract-status', 'x-frozen-at', 'x-source-commit', 'x-compat',
]

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const CONTRACT_LICENSE = 'CC-BY-NC-SA-4.0'
const COMPAT_MODES = new Set(['backward', 'forward', 'full', 'closed', 'additive'])
const CONTRACT_STATUSES = new Set(['frozen', 'draft'])

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

function resolvePointer(rootSchema, pointer) {
  if (pointer === '#' || pointer === '') return { node: rootSchema }
  if (!pointer.startsWith('#/')) {
    return { error: 'only local "#/..." $ref pointers are supported (fail-closed), got ' + pointer }
  }
  let node = rootSchema
  for (const rawPart of pointer.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) {
      return { error: 'unresolvable $ref ' + pointer }
    }
    node = node[part]
  }
  return { node }
}

function auditSchemaKeywords(node, path, errors) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(path + ': not a schema object')
    return
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('x-')) continue
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      errors.push(path + ': unsupported keyword "' + key + '" (fail-closed)')
      continue
    }
    const value = node[key]
    if (key === '$defs') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(path + '.$defs: must be an object')
      else for (const [name, sub] of Object.entries(value)) auditSchemaKeywords(sub, path + '.$defs.' + name, errors)
    } else if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(path + '.properties: must be an object')
      else for (const [name, sub] of Object.entries(value)) auditSchemaKeywords(sub, path + '.properties.' + name, errors)
    } else if (key === 'items') {
      auditSchemaKeywords(value, path + '.items', errors)
    } else if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      if (!Array.isArray(value) || value.length === 0) errors.push(path + '.' + key + ': must be a non-empty array')
      else value.forEach((sub, index) => auditSchemaKeywords(sub, path + '.' + key + '[' + index + ']', errors))
    } else if (key === 'additionalProperties') {
      if (typeof value !== 'boolean') errors.push(path + '.additionalProperties: only boolean is supported (fail-closed)')
    } else if (key === '$ref') {
      if (typeof value !== 'string' || !value.startsWith('#/')) errors.push(path + '.$ref: must be a local "#/..." string')
    } else if (key === 'type') {
      if (typeof value !== 'string') errors.push(path + '.type: only a single string type is supported (fail-closed)')
    } else if (key === 'required') {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) errors.push(path + '.required: must be an array of strings')
    } else if (key === 'pattern') {
      if (typeof value !== 'string') errors.push(path + '.pattern: must be a string')
      else {
        try {
          new RegExp(value)
        } catch (error) {
          errors.push(path + '.pattern: invalid regular expression (' + error.message + ')')
        }
      }
    } else if (key === 'enum') {
      if (!Array.isArray(value) || value.length === 0) errors.push(path + '.enum: must be a non-empty array')
    } else if (key === 'minLength' || key === 'maxLength' || key === 'minimum' || key === 'maximum' || key === 'minItems' || key === 'maxItems') {
      if (typeof value !== 'number') errors.push(path + '.' + key + ': must be a number')
    }
  }
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function validateInstance(value, schema, rootSchema, path, errors) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(path + ': invalid schema node')
    return
  }
  if (typeof schema.$ref === 'string') {
    const resolved = resolvePointer(rootSchema, schema.$ref)
    if (resolved.error) errors.push(path + ': ' + resolved.error)
    else validateInstance(value, resolved.node, rootSchema, path, errors)
    return
  }
  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push(path + ': expected const ' + JSON.stringify(schema.const) + ', got ' + JSON.stringify(value))
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    errors.push(path + ': value ' + JSON.stringify(value) + ' is not one of ' + JSON.stringify(schema.enum))
  }
  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    errors.push(path + ': expected type ' + schema.type + ', got ' + (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value))
    return
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(path + ': shorter than minLength ' + schema.minLength)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(path + ': longer than maxLength ' + schema.maxLength)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(path + ': does not match pattern ' + schema.pattern)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(path + ': below minimum ' + schema.minimum)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(path + ': above maximum ' + schema.maximum)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(path + ': fewer than minItems ' + schema.minItems)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(path + ': more than maxItems ' + schema.maxItems)
    if (schema.items) value.forEach((item, index) => validateInstance(item, schema.items, rootSchema, path + '[' + index + ']', errors))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) errors.push(path + ': missing required property "' + key + '"')
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateInstance(value[key], sub, rootSchema, path + '.' + key, errors)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(path + ': unexpected property "' + key + '" (additionalProperties: false)')
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateInstance(value, sub, rootSchema, path, errors)
  }
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((sub) => {
      const branch = []
      validateInstance(value, sub, rootSchema, path, branch)
      return branch
    })
    if (!branchErrors.some((branch) => branch.length === 0)) {
      errors.push(path + ': does not satisfy anyOf (' + firstErrors(branchErrors[0] ?? [], 2) + ')')
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((sub) => {
      const branch = []
      validateInstance(value, sub, rootSchema, path, branch)
      return branch
    })
    const matching = branchErrors.filter((branch) => branch.length === 0).length
    if (matching !== 1) errors.push(path + ': must match exactly one oneOf branch (matched ' + matching + ')')
  }
}

function schemaDefs(schema) {
  return schema && schema.$defs && typeof schema.$defs === 'object' ? schema.$defs : {}
}

function referencedDefs(schema) {
  const referenced = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) {
      referenced.add(node.$ref.slice('#/$defs/'.length).split('/')[0])
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(schema)
  return referenced
}

function topLevelDefs(schema) {
  const referenced = referencedDefs(schema)
  return Object.keys(schemaDefs(schema)).filter((name) => !referenced.has(name))
}

function validateTarget(value, schema, pointer) {
  const rootSchema = schema
  let node = schema
  if (pointer && pointer !== '#') {
    if (!pointer.startsWith('#/')) return ['target must be a local pointer, got ' + pointer]
    for (const rawPart of pointer.slice(2).split('/')) {
      const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return ['unresolvable target ' + pointer]
      node = node[part]
    }
  }
  const errors = []
  validateInstance(value, node, rootSchema, '$', errors)
  return errors
}

/* ------------------------------------------------------------------ */
/* --schema                                                           */
/* ------------------------------------------------------------------ */

function checkSchemaArtifacts() {
  const jsonFiles = walkFiles(contractsDir, (file) => file.endsWith('.json'))
  let schemaCount = 0
  let defCount = 0
  let failed = 0
  for (const file of jsonFiles) {
    let parsed
    try {
      parsed = readJson(file)
    } catch (error) {
      fail('schema.parse ' + relOf(file), error.message)
      failed += 1
      continue
    }
    if (!file.endsWith('.schema.json')) continue
    schemaCount += 1
    const problems = []
    for (const key of REQUIRED_SCHEMA_METADATA) {
      if (!Object.hasOwn(parsed, key)) problems.push('missing metadata ' + key)
    }
    if (parsed.$schema !== JSON_SCHEMA_DIALECT) problems.push('$schema must be ' + JSON_SCHEMA_DIALECT)
    const expectedId = GITHUB_CONTRACTS + '/' + relative(contractsDir, file).split(sep).join('/')
    if (parsed.$id !== expectedId) problems.push('$id must be ' + expectedId)
    if (!Number.isInteger(parsed.version) || parsed.version < 1) problems.push('version must be a positive integer')
    if (parsed['x-license'] !== CONTRACT_LICENSE) problems.push('x-license must be ' + CONTRACT_LICENSE)
    if (!CONTRACT_STATUSES.has(parsed['x-contract-status'])) problems.push('x-contract-status must be frozen|draft')
    if (!COMPAT_MODES.has(parsed['x-compat'])) problems.push('x-compat must be one of ' + [...COMPAT_MODES].join('|'))
    if (typeof parsed['x-frozen-at'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed['x-frozen-at'])) problems.push('x-frozen-at must be YYYY-MM-DD')
    if (typeof parsed['x-source-commit'] !== 'string' || !/^[0-9a-f]{7,40}$/.test(parsed['x-source-commit'])) problems.push('x-source-commit must be a git sha')
    const defs = Object.keys(schemaDefs(parsed))
    if (defs.length === 0 && !parsed.properties) problems.push('neither $defs nor a root properties contract')
    defCount += defs.length
    auditSchemaKeywords(parsed, relOf(file), problems)
    if (problems.length) {
      fail('schema.metadata ' + relOf(file), firstErrors(problems, 4))
      failed += 1
    } else {
      pass('schema.metadata ' + relOf(file), defs.length + ' $defs')
    }
  }
  if (failed === 0) pass('schema.artifacts', schemaCount + ' schema file(s), ' + jsonFiles.length + ' JSON artifact(s), ' + defCount + ' $defs parse and use the supported keyword subset')
  else fail('schema.artifacts', failed + ' schema file(s) invalid')
  const refSources = [
    ['cli/commands-v1.json', (json) => (json.commands ?? []).map((command) => command.schemaRef)],
    ['mcp/tools-v1.json', (json) => (json.tools ?? []).map((tool) => tool.responseSchemaRef)],
    ['mcp/resources-v1.json', (json) => (json.resources ?? []).map((resource) => resource.schemaRef)],
  ]
  const refProblems = []
  for (const [rel, collect] of refSources) {
    const file = join(contractsDir, rel)
    if (!existsSync(file)) { refProblems.push(rel + ': missing'); continue }
    for (const schemaRef of collect(readJson(file))) {
      if (typeof schemaRef !== 'string' || !schemaRef.includes('#')) { refProblems.push(rel + ': bad schemaRef ' + String(schemaRef)); continue }
      const [schemaFile, pointer] = schemaRef.split('#')
      const target = join(dirname(file), schemaFile)
      if (!existsSync(target)) { refProblems.push(rel + ': missing schema ' + schemaFile); continue }
      const schemaRoot = readJson(target)
      const pointerPath = pointer === '/' ? '#' : '#' + pointer
      if (pointerPath !== '#' && !pointerPath.startsWith('#/')) { refProblems.push(rel + ': bad pointer ' + schemaRef); continue }
      const resolved = resolvePointer(schemaRoot, pointerPath)
      if (resolved.error) refProblems.push(rel + ': ' + resolved.error)
    }
  }
  if (refProblems.length) fail('schema.schemaRefs', firstErrors(refProblems, 4))
  else pass('schema.schemaRefs', 'catalogue schemaRefs resolve')
}

/* ------------------------------------------------------------------ */
/* --vectors                                                          */
/* ------------------------------------------------------------------ */

function checkVectors() {
  const vectorFiles = walkFiles(join(contractsDir, 'vectors'), (file) => file.endsWith('.vectors.json'))
  let caseCount = 0
  let failedFiles = 0
  for (const file of vectorFiles) {
    let vectors
    try {
      vectors = readJson(file)
    } catch (error) {
      fail('vectors.parse ' + relOf(file), error.message)
      failedFiles += 1
      continue
    }
    const problems = []
    const schemaFile = join(dirname(file), vectors.schema ?? '')
    let schema
    if (!vectors.schema || !existsSync(schemaFile)) {
      problems.push('schema file missing: ' + String(vectors.schema))
    } else {
      schema = readJson(schemaFile)
    }
    const cases = Array.isArray(vectors.cases) ? vectors.cases : []
    if (cases.length < 3) problems.push('needs at least 3 cases')
    if (schema) {
      const top = topLevelDefs(schema).map((name) => '#/$defs/' + name)
      const covers = Array.isArray(vectors.covers) ? [...vectors.covers].sort() : []
      const expectedCovers = (top.length ? top : ['#']).sort()
      if (!deepEqual(covers, expectedCovers)) {
        problems.push('covers must list every top-level $def exactly (expected ' + expectedCovers.join(', ') + ')')
      }
      for (const testCase of cases) {
        const id = typeof testCase.id === 'string' ? testCase.id : '(missing id)'
        if (typeof testCase.target !== 'string') { problems.push(id + ': target missing'); continue }
        if (testCase.expect !== 'accept' && testCase.expect !== 'reject') { problems.push(id + ': expect must be accept|reject'); continue }
        if (!Object.hasOwn(testCase, 'value')) { problems.push(id + ': value missing'); continue }
        const errors = validateTarget(testCase.value, schema, testCase.target)
        if (testCase.expect === 'accept' && errors.length) problems.push(id + ': expected accept but got ' + firstErrors(errors, 2))
        if (testCase.expect === 'reject' && errors.length === 0) problems.push(id + ': expected reject but schema accepted it')
      }
    }
    caseCount += cases.length
    if (problems.length) {
      fail('vectors.' + relOf(file), firstErrors(problems, 4))
      failedFiles += 1
    } else {
      pass('vectors.' + relOf(file), cases.length + ' cases')
    }
  }
  if (failedFiles === 0) pass('vectors.artifacts', caseCount + ' conformance case(s) across ' + vectorFiles.length + ' vector file(s)')
  else fail('vectors.artifacts', failedFiles + ' vector file(s) invalid')
}

/* ------------------------------------------------------------------ */
/* CLI process helpers                                                */
/* ------------------------------------------------------------------ */

function cliEnv(home, options = {}) {
  const acceptTos = options.acceptTos !== false
  const env = {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
  }
  delete env.ADVISERS_API_KEY
  delete env.DEEPSEEK_API_KEY
  delete env.OPENAI_API_KEY
  if (acceptTos) env.ADVISERS_ACCEPT_TOS = '1'
  else delete env.ADVISERS_ACCEPT_TOS
  return env
}

function runCli(space, argv, options = {}) {
  return spawnSync(process.execPath, [binPath, ...argv], {
    cwd: options.cwd ?? space.work,
    env: cliEnv(space.home, options),
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
  })
}

function cliPkgVersion() {
  return readJson(cliPkgPath).version
}

function runCliForJson(space, argv, label, options = {}) {
  const result = runCli(space, argv, options)
  if (result.status !== 0) {
    return { error: label + ' exited ' + result.status + ' (stderr: ' + String(result.stderr ?? '').trim().slice(0, 300) + ')' }
  }
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch (error) {
    return { error: label + ' stdout is not one JSON document: ' + error.message }
  }
  return { payload, result }
}

function readModelsSchema() {
  return readJson(join(contractsDir, 'cli/read-models-v1.schema.json'))
}

/* ------------------------------------------------------------------ */
/* --cli                                                              */
/* ------------------------------------------------------------------ */

function checkCli() {
  const space = tempWorkspace('cli')
  try {
    const commandsFile = readJson(join(contractsDir, 'cli/commands-v1.json'))
    const schema = readModelsSchema()
    const ids = {}
    for (const seed of commandsFile.fixtures?.seed ?? []) {
      const result = runCli(space, seed.argv)
      if (result.status !== 0) {
        fail('cli.seed ' + seed.id, 'exited ' + result.status + ' (stderr: ' + String(result.stderr ?? '').trim().slice(0, 300) + ')')
        return
      }
    }
    const matters = runCliForJson(space, ['matter', 'ls', '--json'], 'matter ls (seed)')
    if (matters.error) { fail('cli.seed-ids', matters.error); return }
    ids.matterId = matters.payload[0]?.id
    const commitments = runCliForJson(space, ['commit', 'ls', '--json'], 'commit ls (seed)')
    if (commitments.error) { fail('cli.seed-ids', commitments.error); return }
    ids.commitmentId = commitments.payload[0]?.id
    if (!ids.matterId || !ids.commitmentId) { fail('cli.seed-ids', 'fixtures did not create a matter and a commitment'); return }
    const substitute = (argv) => argv.map((arg) => arg
      .replace('{matterId}', ids.matterId)
      .replace('{commitmentId}', ids.commitmentId)
      .replace('{missingDir}', join(space.dir, 'missing-pack-dir')))
    let checked = 0
    const failedCommands = []
    for (const command of commandsFile.commands ?? []) {
      const argv = substitute(command.argv ?? [])
      const label = 'cli.' + command.id
      const result = runCliForJson(space, argv, label)
      if (result.error) { fail(label, result.error); failedCommands.push(command.id); continue }
      const isArray = Array.isArray(result.payload)
      if ((command.root === 'array') !== isArray) {
        fail(label, 'root shape mismatch: contract says ' + command.root + ', stdout is ' + (isArray ? 'array' : 'object'))
        failedCommands.push(command.id)
        continue
      }
      const errors = []
      const pointer = command.schemaRef.split('#')[1] ?? '#'
      if (isArray) {
        const resolved = resolvePointer(schema, '#' + pointer)
        result.payload.forEach((item, index) => {
          if (resolved.error) errors.push(resolved.error)
          else validateInstance(item, resolved.node, schema, '$[' + index + ']', errors)
        })
      } else if (pointer === '#') {
        validateInstance(result.payload, schema, schema, '$', errors)
      } else {
        const resolved = resolvePointer(schema, '#' + pointer)
        if (resolved.error) errors.push(resolved.error)
        else validateInstance(result.payload, resolved.node, schema, '$', errors)
      }
      if (errors.length) { fail(label, firstErrors(errors, 3)); failedCommands.push(command.id) }
      else { pass(label); checked += 1 }
    }
    if (failedCommands.length === 0) pass('cli.commands', checked + ' deterministic --json command(s) match commands-v1.json')
    else fail('cli.commands', failedCommands.length + ' command(s) drifted: ' + failedCommands.join(', '))
  } finally {
    cleanupWorkspace(space)
  }
}

/* ------------------------------------------------------------------ */
/* --status                                                           */
/* ------------------------------------------------------------------ */

function checkStatus() {
  const space = tempWorkspace('status')
  try {
    const descriptor = readJson(join(contractsDir, 'cli/status-v1.json'))
    const versions = readJson(join(contractsDir, 'versions-v1.json'))
    const mcpVersions = readJson(join(contractsDir, 'mcp/versions-v1.json'))
    const schema = readModelsSchema()
    const result = runCli(space, descriptor.argv, { acceptTos: false })
    if (result.status !== 0) {
      fail('status.fresh-home', 'status exited ' + result.status + ' on a fresh home with no TOS acceptance (stderr: ' + String(result.stderr ?? '').trim().slice(0, 300) + ')')
      return
    }
    pass('status.fresh-home', 'exit 0 with no TOS acceptance and no credentials')
    if (String(result.stderr ?? '').trim().length > 0) fail('status.stderr-purity', 'status wrote to stderr in --json mode')
    else pass('status.stderr-purity')
    let payload
    try {
      payload = JSON.parse(result.stdout)
    } catch (error) {
      fail('status.json-purity', 'stdout is not one JSON document: ' + error.message)
      return
    }
    const errors = validateTarget(payload, schema, '#/$defs/StatusPayload')
    if (errors.length) fail('status.schema', firstErrors(errors, 4))
    else pass('status.schema', 'StatusPayload')
    if (payload.home === space.home) pass('status.home', 'payload.home is the temporary ADVISERS_HOME')
    else fail('status.home', 'payload.home=' + String(payload.home) + ' is not the temporary ADVISERS_HOME')
    const expected = versions.discovery.expected
    if (!payload.contracts) {
      info('status.contracts discovery field is not wired yet (expected until the Wave 2 bin/ integration); --status passes on the frozen shape only')
      return
    }
    const discoveryErrors = validateTarget(payload.contracts, schema, '#/$defs/ContractsDiscovery')
    const problems = [...discoveryErrors]
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(payload.contracts, key)) problems.push('missing discovery key ' + key)
      else if (key === 'mcpProtocol') {
        if (!mcpVersions.supportedProtocolVersions.includes(payload.contracts[key])) problems.push('mcpProtocol ' + String(payload.contracts[key]) + ' is not in mcp/versions-v1.json supportedProtocolVersions')
      } else if (!deepEqual(payload.contracts[key], value)) {
        problems.push('discovery.' + key + '=' + JSON.stringify(payload.contracts[key]) + ' but versions-v1.json expects ' + JSON.stringify(value))
      }
    }
    if (problems.length) fail('status.contracts', firstErrors(problems, 4))
    else pass('status.contracts', 'status.contracts equals versions-v1.json discovery.expected')
  } finally {
    cleanupWorkspace(space)
  }
}

/* ------------------------------------------------------------------ */
/* --exit                                                             */
/* ------------------------------------------------------------------ */

function checkExitCodes() {
  const space = tempWorkspace('exit')
  try {
    const contract = readJson(join(contractsDir, 'cli/exit-codes-v1.json'))
    const errorsSchema = readJson(join(contractsDir, 'cli/errors-v1.schema.json'))
    let checked = 0
    const failedProbes = []
    for (const probe of contract.probes ?? []) {
      const probeSpace = tempWorkspace('exit-probe')
      try {
        const missingDir = join(probeSpace.dir, 'missing-pack-dir')
        const argv = (probe.argv ?? []).map((arg) => arg.replace('{missingDir}', missingDir))
        const acceptTos = probe.home === 'accepted'
        const result = runCli(probeSpace, argv, { acceptTos })
        const label = 'exit.' + probe.id
        const problems = []
        if (result.status !== probe.expectExit) problems.push('expected exit ' + probe.expectExit + ', got ' + result.status)
        const stdout = String(result.stdout ?? '')
        const stderr = String(result.stderr ?? '')
        if (probe.expectStdout === 'json') {
          try {
            JSON.parse(stdout)
          } catch (error) {
            problems.push('stdout is not JSON: ' + error.message)
          }
        } else if (probe.expectStdout === 'text' && stdout.trim().length === 0) {
          problems.push('expected non-empty stdout')
        }
        if (probe.expectStderr === 'error-envelope') {
          let envelope
          try {
            envelope = JSON.parse(stderr.trim())
          } catch (error) {
            problems.push('stderr is not a single JSON error envelope: ' + error.message)
          }
          if (envelope) {
            const envelopeErrors = []
            validateInstance(envelope, errorsSchema, errorsSchema, '$', envelopeErrors)
            if (envelopeErrors.length) problems.push('error envelope invalid: ' + firstErrors(envelopeErrors, 2))
            if (probe.expectCode && envelope.error?.code !== probe.expectCode) problems.push('expected code ' + probe.expectCode + ', got ' + String(envelope.error?.code))
          }
        }
        if (probe.expectStderrPattern && !(new RegExp(probe.expectStderrPattern).test(stderr))) {
          problems.push('stderr does not match ' + probe.expectStderrPattern)
        }
        if (problems.length) { fail(label, firstErrors(problems, 3)); failedProbes.push(probe.id) }
        else { pass(label, 'exit ' + result.status); checked += 1 }
      } finally {
        cleanupWorkspace(probeSpace)
      }
    }
    const codeValues = new Set((contract.codes ?? []).map((entry) => entry.code))
    const problems = []
    if (contract.codeToExit?.default !== 1) problems.push('codeToExit.default must be 1')
    if (contract.codeToExit?.E_TOS_REQUIRED !== 3) problems.push('codeToExit.E_TOS_REQUIRED must be 3')
    for (const code of codeValues) if (!Number.isInteger(code)) problems.push('non-integer exit code ' + String(code))
    if (problems.length) fail('exit.contract-map', firstErrors(problems, 3))
    else pass('exit.contract-map', [...codeValues].join('/'))
    if (failedProbes.length === 0) pass('exit.probes', checked + ' probe(s) match the frozen exit codes')
    else fail('exit.probes', failedProbes.length + ' probe(s) drifted: ' + failedProbes.join(', '))
  } finally {
    cleanupWorkspace(space)
  }
}

/* ------------------------------------------------------------------ */
/* --mcp                                                              */
/* ------------------------------------------------------------------ */

function mcpSession(space, input) {
  return spawnSync(process.execPath, [binPath, 'mcp', '--stdio'], {
    cwd: space.work,
    env: cliEnv(space.home, { acceptTos: true }),
    encoding: 'utf8',
    input,
    timeout: TEST_TIMEOUT_MS,
  })
}

function collectToolPayload(envelope, def, schema, label, problems) {
  const envelopeErrors = validateTarget(envelope, schema, '#/$defs/ToolCallResult')
  if (envelopeErrors.length) { problems.push(label + ' envelope: ' + firstErrors(envelopeErrors, 2)); return }
  if (envelope.result.isError) { problems.push(label + ' returned isError=true'); return }
  let payload
  try {
    payload = JSON.parse(envelope.result.content[0].text)
  } catch (error) {
    problems.push(label + ' payload is not JSON: ' + error.message)
    return
  }
  const payloadErrors = validateTarget(payload, schema, def)
  if (payloadErrors.length) problems.push(label + ' payload: ' + firstErrors(payloadErrors, 2))
}

function checkMcp() {
  const space = tempWorkspace('mcp')
  try {
    const catalog = readJson(join(contractsDir, 'mcp/tools-v1.json'))
    const resourcesContract = readJson(join(contractsDir, 'mcp/resources-v1.json'))
    const protocol = readJson(join(contractsDir, 'mcp/versions-v1.json'))
    const errorsContract = readJson(join(contractsDir, 'mcp/errors-v1.json'))
    const schema = readJson(join(contractsDir, 'mcp/responses-v1.schema.json'))
    const cliVersion = cliPkgVersion()
    const seed = runCli(space, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--due', '2026-12-01T10:00:00+08:00'])
    if (seed.status !== 0) { fail('mcp.seed', 'seed commitment exited ' + seed.status + ' (stderr: ' + String(seed.stderr ?? '').trim().slice(0, 300) + ')'); return }
    const commitList = runCliForJson(space, ['commit', 'ls', '--json'], 'mcp seed commit list')
    if (commitList.error) { fail('mcp.seed', commitList.error); return }
    const commitmentId = commitList.payload[0]?.id
    if (!commitmentId) { fail('mcp.seed', 'seed did not create a commitment'); return }
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: protocol.defaultProtocolVersion, capabilities: {}, clientInfo: { name: 'check-contracts', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    ]
    resourcesContract.resources.forEach((resource, index) => {
      requests.push({ jsonrpc: '2.0', id: 10 + index, method: 'resources/read', params: { uri: resource.uri } })
    })
    requests.push(
      { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } },
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'advisers_commit_ls', arguments: { all: true } } },
      { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'advisers_who', arguments: {} } },
      { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'advisers_evidence', arguments: { id: commitmentId } } },
      { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'advisers_remind', arguments: {} } },
      { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'advisers_capture_candidate', arguments: { action: '合同样例动作', quote: '合同样例引文' } } },
    )
    const errorProbeIds = new Map()
    errorsContract.probes.forEach((probe, index) => {
      if (!probe.request) return
      const id = 40 + index
      errorProbeIds.set(probe.id, id)
      requests.push({ ...probe.request, id })
    })
    if (protocol.negotiation === 'active' || protocol.negotiation === 'active-fallback') {
      requests.push(
        { jsonrpc: '2.0', id: 90, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'check-contracts', version: '1' } } },
        { jsonrpc: '2.0', id: 91, method: 'initialize', params: { protocolVersion: protocol.supportedProtocolVersions[protocol.supportedProtocolVersions.length - 1], capabilities: {}, clientInfo: { name: 'check-contracts', version: '1' } } },
      )
    }
    const input = requests.map((request) => JSON.stringify(request)).join('\n') + '\nnot json\n'
    const session = mcpSession(space, input)
    if (session.status !== 0) {
      fail('mcp.session', 'mcp --stdio exited ' + session.status + ' (stderr: ' + String(session.stderr ?? '').trim().slice(0, 300) + ')')
      return
    }
    let lines
    try {
      lines = String(session.stdout ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch (error) {
      fail('mcp.session', 'stdout is not one JSON-RPC object per line: ' + error.message)
      return
    }
    const byId = new Map()
    for (const line of lines) if (line && line.id !== undefined && line.id !== null) byId.set(line.id, line)
    const response = (id) => byId.get(id)
    const parseError = lines.find((line) => line?.error?.code === -32700)
    const problems = []
    const init = response(1)
    if (!init) problems.push('no initialize response')
    else {
      const initErrors = validateTarget(init, schema, '#/$defs/InitializeResult')
      problems.push(...initErrors.map((error) => 'initialize: ' + error))
      const answeredVersion = init.result?.protocolVersion
      if (!protocol.supportedProtocolVersions.includes(answeredVersion)) problems.push('initialize answered unsupported protocolVersion ' + String(answeredVersion))
      if (init.result?.serverInfo?.name !== protocol.serverInfo.name) problems.push('serverInfo.name must be ' + protocol.serverInfo.name)
      if (init.result?.serverInfo?.version !== cliVersion) problems.push('serverInfo.version ' + String(init.result?.serverInfo?.version) + ' must equal packages/advisers/package.json ' + cliVersion)
    }
    const toolsResponse = response(2)
    const serverTools = toolsResponse?.result?.tools
    if (!Array.isArray(serverTools)) problems.push('no tools/list result')
    else {
      const toolsErrors = validateTarget(toolsResponse, schema, '#/$defs/ToolsListResult')
      problems.push(...toolsErrors.map((error) => 'tools/list: ' + error))
      if (serverTools.length !== catalog.tools.length) problems.push('tools/list has ' + serverTools.length + ' tools, contract has ' + catalog.tools.length)
      for (let index = 0; index < Math.min(serverTools.length, catalog.tools.length); index += 1) {
        const server = serverTools[index]
        const contract = catalog.tools[index]
        if (server.name !== contract.name) problems.push('tools/list[' + index + '] name ' + server.name + ' != ' + contract.name)
        if (!deepEqual(server.inputSchema, contract.inputSchema)) problems.push('tool ' + server.name + ' inputSchema drifted from mcp/tools-v1.json')
        if (!deepEqual(server.annotations, contract.annotations)) problems.push('tool ' + server.name + ' annotations drifted from mcp/tools-v1.json')
        if (typeof server.description !== 'string' || server.description.length === 0) problems.push('tool ' + server.name + ' description missing')
      }
    }
    const resourcesResponse = response(3)
    const serverResources = resourcesResponse?.result?.resources
    if (!Array.isArray(serverResources)) problems.push('no resources/list result')
    else {
      const resourcesErrors = validateTarget(resourcesResponse, schema, '#/$defs/ResourcesListResult')
      problems.push(...resourcesErrors.map((error) => 'resources/list: ' + error))
      if (serverResources.length !== resourcesContract.resources.length) problems.push('resources/list has ' + serverResources.length + ' resources, contract has ' + resourcesContract.resources.length)
      const byUri = new Map(serverResources.map((resource) => [resource.uri, resource]))
      for (const contract of resourcesContract.resources) {
        const server = byUri.get(contract.uri)
        if (!server) { problems.push('missing resource ' + contract.uri); continue }
        if (server.name !== contract.name) problems.push('resource ' + contract.uri + ' name drifted')
        if (server.mimeType !== contract.mimeType) problems.push('resource ' + contract.uri + ' mimeType drifted')
      }
    }
    resourcesContract.resources.forEach((resource, index) => {
      const envelope = response(10 + index)
      const label = 'resources/read ' + resource.uri
      if (!envelope) { problems.push('no ' + label + ' response'); return }
      const envelopeErrors = validateTarget(envelope, schema, '#/$defs/ResourceReadResult')
      if (envelopeErrors.length) { problems.push(label + ': ' + firstErrors(envelopeErrors, 2)); return }
      let payload
      try {
        payload = JSON.parse(envelope.result.contents[0].text)
      } catch (error) {
        problems.push(label + ' text is not JSON: ' + error.message)
        return
      }
      const pointer = resource.schemaRef.split('#')[1]
      const payloadErrors = validateTarget(payload, schema, '#' + pointer)
      if (payloadErrors.length) problems.push(label + ' payload: ' + firstErrors(payloadErrors, 2))
    })
    const toolCalls = [
      ['advisers_today', 20],
      ['advisers_commit_ls', 21],
      ['advisers_who', 22],
      ['advisers_evidence', 23],
      ['advisers_remind', 24],
      ['advisers_capture_candidate', 25],
    ]
    for (const [name, id] of toolCalls) {
      const envelope = response(id)
      const tool = catalog.tools.find((entry) => entry.name === name)
      if (!envelope) { problems.push('no tools/call response for ' + name); continue }
      const pointer = tool?.responseSchemaRef?.split('#')[1]
      if (!pointer) { problems.push('tool ' + name + ' has no responseSchemaRef in mcp/tools-v1.json'); continue }
      const before = problems.length
      collectToolPayload(envelope, '#' + pointer, schema, 'tools/call ' + name, problems)
      if (problems.length === before && name === 'advisers_capture_candidate') {
        let payload
        try {
          payload = JSON.parse(envelope.result.content[0].text)
        } catch {
          payload = null
        }
        if (payload?.candidate?.status !== 'pending') problems.push('capture candidate must stay pending')
      }
    }
    for (const probe of errorsContract.probes) {
      const id = errorProbeIds.get(probe.id)
      if (id === undefined) continue
      const found = response(id)
      const label = 'probe ' + probe.id
      if (!found) { problems.push('no JSON-RPC error response for ' + label); continue }
      const errorErrors = validateTarget(found, schema, '#/$defs/JsonRpcErrorResponse')
      if (errorErrors.length) problems.push(label + ': ' + firstErrors(errorErrors, 2))
      if (found.error?.code !== probe.expectCode) problems.push(label + ' expected code ' + probe.expectCode + ', got ' + String(found.error?.code))
    }
    if (!parseError) problems.push('no -32700 parse error response for an invalid JSON line')
    else {
      const parseErrors = validateTarget(parseError, schema, '#/$defs/JsonRpcErrorResponse')
      if (parseErrors.length) problems.push('parse error response: ' + firstErrors(parseErrors, 2))
    }
    if (protocol.negotiation === 'active') {
      const rejected = response(90)
      const message = String(rejected?.error?.message ?? '')
      if (!rejected?.error) problems.push('unsupported future protocol version was not rejected')
      if (protocol.supportedProtocolVersions.some((version) => !message.includes(version))) problems.push('unsupported-version error does not list the supported versions')
    } else if (protocol.negotiation === 'active-fallback') {
      const fallback = response(90)
      if (!fallback?.result) problems.push('an unknown protocol version must fall back to the default result, not ' + JSON.stringify(fallback?.error ?? null))
      else if (fallback.result.protocolVersion !== protocol.defaultProtocolVersion) problems.push('unknown-version fallback answered ' + String(fallback.result.protocolVersion) + ' instead of the default ' + protocol.defaultProtocolVersion)
      const echoed = response(91)
      const requested = protocol.supportedProtocolVersions[protocol.supportedProtocolVersions.length - 1]
      if (!echoed?.result) problems.push('initialize with supported version ' + requested + ' returned an error')
      else if (echoed.result.protocolVersion !== requested) problems.push('initialize did not echo supported version ' + requested + ' (got ' + String(echoed.result.protocolVersion) + ')')
    } else {
      info('MCP negotiation is pending-integration-wave: checker only requires the answered version to be in the supported list')
    }
    if (problems.length) fail('mcp.surface', firstErrors(problems, 5))
    else pass('mcp.surface', catalog.tools.length + ' tools, ' + resourcesContract.resources.length + ' resources, resources/read, tool calls, ' + errorsContract.probes.length + ' error probes, catalogue deep-equal')
  } finally {
    cleanupWorkspace(space)
  }
}

/* ------------------------------------------------------------------ */
/* error registry scan + generated files                              */
/* ------------------------------------------------------------------ */

const CODE_LITERAL_RE = /\bE_[A-Z][A-Z0-9_]*\b/g
const SOURCE_PREFIXES = ['packages/advisers/lib/', 'packages/advisers/bin/']
const REGISTRY_SELF = 'packages/advisers/lib/error-codes.js'

function gitList(extraArgs) {
  const result = spawnSync('git', ['-C', root, ...extraArgs], { encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0) return null
  return String(result.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
}

function isScannedSource(rel) {
  return SOURCE_PREFIXES.some((prefix) => rel.startsWith(prefix))
    && rel.endsWith('.js')
    && rel !== REGISTRY_SELF
}

function sourceFiles(options = {}) {
  const tracked = options.tracked !== false
  const listed = gitList(tracked
    ? ['ls-files']
    : ['ls-files', '--others', '--exclude-standard'])
  let files
  if (listed === null) {
    files = walkFiles(join(root, 'packages/advisers'), (file) => file.endsWith('.js')).map((file) => relOf(file))
  } else {
    files = listed
  }
  return files.filter(isScannedSource).sort()
}

/**
 * Scan the COMMITTED source (git HEAD) for E_* literals. The registry is a
 * committed baseline: uncommitted parallel work (this repo is edited by several
 * agents/branches at once) must not fight the registry before it is committed.
 * Once a change is committed, a new literal fails the gate until it is
 * registered. Falls back to the working tree outside a git checkout.
 */
function scanCommittedErrorCodeLiterals() {
  const result = spawnSync('git', [
    '-C', root, 'grep', '-n', '-I', '-E',
    '(^|[^A-Za-z0-9_])E_[A-Z][A-Z0-9_]*',
    'HEAD', '--', 'packages/advisers/lib', 'packages/advisers/bin',
  ], { encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0 && result.status !== 1) return null
  const found = new Map()
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = /^HEAD:(.+?):([0-9]+):(.*)$/.exec(line)
    if (!match) continue
    const rel = match[1]
    if (!isScannedSource(rel)) continue
    for (const codeMatch of match[3].matchAll(CODE_LITERAL_RE)) {
      if (!found.has(codeMatch[0])) found.set(codeMatch[0], [])
      found.get(codeMatch[0]).push(rel + ':' + match[2])
    }
  }
  return found
}

function scanErrorCodeLiterals(files) {
  const found = new Map()
  for (const rel of files) {
    const lines = readText(join(root, rel)).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(CODE_LITERAL_RE)) {
        if (!found.has(match[0])) found.set(match[0], [])
        found.get(match[0]).push(rel + ':' + (index + 1))
      }
    }
  }
  return found
}

function buildRegistryJson() {
  return {
    $id: GITHUB_CONTRACTS + '/errors/codes.v1.json',
    version: ERROR_CODE_VERSION,
    status: 'frozen',
    frozenAt: ERROR_CODES_FROZEN_AT,
    sourceCommit: ERROR_CODES_SOURCE_COMMIT,
    sourceVersion: ERROR_CODES_SOURCE_VERSION,
    release: ERROR_CODES_RELEASE,
    baseline: { commit: ERROR_CODES_SOURCE_COMMIT, codeCount: ERROR_CODES_BASELINE_COUNT },
    source: REGISTRY_SELF,
    description: 'Generated from packages/advisers/lib/error-codes.js by scripts/check-contracts.mjs --update. The registry is the single source of truth for CLI error codes; do not edit it by hand.',
    exitCodes: { default: 1, E_TOS_REQUIRED: 3 },
    categories: [...ERROR_CATEGORIES],
    surfaces: [...ERROR_SURFACES],
    codes: ERROR_CODE_LIST.map((code) => {
      const entry = ERROR_CODES[code]
      const json = {
        code: entry.code,
        category: entry.category,
        exit: entry.exit,
        surfaces: [...entry.surfaces],
        since: entry.since,
        stable: entry.stable,
        remedy: entry.remedy,
      }
      if (entry.doc) json.doc = entry.doc
      return json
    }),
    external: Object.values(DSH_ERROR_CODES).map((entry) => ({
      code: entry.code,
      category: entry.category,
      surfaces: [...entry.surfaces],
      since: entry.since,
      stable: entry.stable,
      remedy: entry.remedy,
      source: entry.source,
    })),
  }
}

function renderErrorCodesDoc() {
  const bt = String.fromCharCode(96)
  const fence = bt + bt + bt
  const registry = buildRegistryJson()
  const lines = []
  lines.push('# Advisers error codes (registry v1)')
  lines.push('')
  lines.push('<!-- generated by scripts/check-contracts.mjs --update from packages/advisers/lib/error-codes.js; do not edit by hand -->')
  lines.push('')
  lines.push('Baseline: ' + registry.baseline.codeCount + ' codes frozen from committed 0.2.4 source at git ' + bt + registry.baseline.commit + bt + ' (package ' + registry.sourceVersion + '), frozen ' + registry.frozenAt + '.')
  lines.push('Plus ' + (registry.codes.length - registry.baseline.codeCount) + ' additive ' + bt + registry.release + bt + ' codes extracted from modules landing in the same release (provisional until their modules are committed).')
  lines.push('')
  lines.push('The registry is the single source of truth: CLI, MCP and library error handling must use codes listed here,')
  lines.push('and a new ' + bt + 'E_*' + bt + ' literal in tracked source fails ' + bt + 'node scripts/check-contracts.mjs --errors' + bt + ' until it is registered.')
  lines.push('Codes are additive: never rename or change the meaning of an existing code.')
  lines.push('')
  lines.push('Exit codes: ' + registry.codes.length + ' CLI codes and ' + registry.external.length + ' DSH external codes.')
  lines.push('')
  lines.push('| Exit | Meaning |')
  lines.push('|---|---|')
  lines.push('| 0 | success |')
  lines.push('| 1 | user/config/runtime error (the default for registered codes) |')
  lines.push('| 3 | TOS consent required (' + bt + 'E_TOS_REQUIRED' + bt + ') |')
  lines.push('')
  lines.push('Exit 4/5/6 are reserved by ' + bt + 'contracts/cli/exit-codes-v2.draft.json' + bt + ' and are **not active**; scripts must read ' + bt + 'error.code' + bt + '.')
  lines.push('')
  lines.push('## CLI error codes')
  lines.push('')
  lines.push('| Code | Category | Exit | Since | Surfaces | Stable | Remedy | Doc |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const entry of registry.codes) {
    const doc = entry.doc ? bt + entry.doc + bt : ''
    lines.push('| ' + bt + entry.code + bt + ' | ' + entry.category + ' | ' + entry.exit + ' | ' + entry.since + ' | ' + entry.surfaces.join(', ') + ' | ' + (entry.stable ? 'yes' : 'no') + ' | ' + entry.remedy + ' | ' + doc + ' |')
  }
  lines.push('')
  lines.push('## DSH adapter external codes (kept verbatim)')
  lines.push('')
  lines.push('These are part of the DSH tool contract, not ' + bt + 'E_*' + bt + ' codes; they are preserved additively.')
  lines.push('')
  lines.push('| Code | Category | Surfaces | Stable | Remedy | Source |')
  lines.push('|---|---|---|---|---|---|')
  for (const entry of registry.external) {
    lines.push('| ' + bt + entry.code + bt + ' | ' + entry.category + ' | ' + entry.surfaces.join(', ') + ' | ' + (entry.stable ? 'yes' : 'no') + ' | ' + entry.remedy + ' | ' + bt + entry.source + bt + ' |')
  }
  lines.push('')
  lines.push('## Adding a code')
  lines.push('')
  lines.push('1. Add the entry to ' + bt + 'packages/advisers/lib/error-codes.js' + bt + ' (category, exit 1 or 3, surfaces, since, stable, remedy, optional doc).')
  lines.push('2. Run ' + bt + 'node scripts/check-contracts.mjs --update' + bt + ' to regenerate this file and ' + bt + 'contracts/errors/codes.v1.json' + bt + '.')
  lines.push('3. Run ' + bt + 'node scripts/check-contracts.mjs --errors' + bt + '; every tracked source literal must be registered and every registered code must still exist.')
  lines.push('')
  lines.push(fence + 'sh')
  lines.push('node scripts/check-contracts.mjs --errors --update')
  lines.push('node scripts/check-contracts.mjs')
  lines.push(fence)
  lines.push('')
  return lines.join('\n')
}

/** Codes present anywhere in the working tree (committed baseline + in-progress modules). */
function scanWorktreeErrorCodeLiterals() {
  const files = walkFiles(join(root, 'packages/advisers'), (file) => file.endsWith('.js'))
    .map((file) => relOf(file))
    .filter(isScannedSource)
  return scanErrorCodeLiterals(files)
}

function checkErrorRegistry() {
  const generated = JSON.stringify(buildRegistryJson(), null, 2) + '\n'
  const generatedDocs = renderErrorCodesDoc()
  const committed = scanCommittedErrorCodeLiterals()
  const tracked = committed ?? scanErrorCodeLiterals(sourceFiles({ tracked: true }))
  const pending = scanErrorCodeLiterals(sourceFiles({ tracked: false }))
  const worktree = scanWorktreeErrorCodeLiterals()
  const registered = new Set(ERROR_CODE_LIST)
  const allSource = new Map(tracked)
  for (const [code, locations] of pending) if (!allSource.has(code)) allSource.set(code, locations)
  const problems = []
  for (const code of ERROR_CODE_LIST) {
    const entry = ERROR_CODES[code]
    if (!ERROR_CATEGORIES.includes(entry.category)) problems.push(code + ': unknown category ' + String(entry.category))
    if (!Number.isInteger(entry.exit) || entry.exit < 0) problems.push(code + ': exit must be an integer')
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0 || !entry.surfaces.every((surface) => ERROR_SURFACES.includes(surface))) problems.push(code + ': surfaces must be a non-empty subset of ' + ERROR_SURFACES.join('|'))
    if (typeof entry.remedy !== 'string' || entry.remedy.length < 10) problems.push(code + ': remedy must be an actionable sentence')
    if (typeof entry.stable !== 'boolean') problems.push(code + ': stable must be boolean')
    if (entry.since !== '0.2.x' && entry.since !== '0.3.0') problems.push(code + ': since must be 0.2.x|0.3.0')
    if (entry.doc && (!existsSync(join(root, entry.doc)) || !readText(join(root, entry.doc)).includes(code))) problems.push(code + ': doc ' + entry.doc + ' is missing or does not mention the code')
    if (!tracked.has(code) && !worktree.has(code)) problems.push(code + ': registered but present in neither committed nor working-tree source (stale entry?)')
    if (entry.exit !== (code === 'E_TOS_REQUIRED' ? 3 : 1)) problems.push(code + ': exit ' + entry.exit + ' does not match the frozen map (3 for E_TOS_REQUIRED, 1 otherwise)')
  }
  if (!deepEqual([...ERROR_CODE_LIST].sort(), Object.keys(ERROR_CODES).sort())) problems.push('ERROR_CODE_LIST is not the sorted key set')
  if (problems.length) fail('errors.registry', firstErrors(problems, 5))
  else pass('errors.registry', ERROR_CODE_LIST.length + ' codes structurally valid (' + ERROR_CODES_BASELINE_COUNT + ' baseline + ' + (ERROR_CODE_LIST.length - ERROR_CODES_BASELINE_COUNT) + ' ' + ERROR_CODES_RELEASE + ' additive)')
  const provisional = ERROR_CODE_LIST.filter((code) => !tracked.has(code) && worktree.has(code))
  if (provisional.length) {
    info(provisional.length + ' ' + ERROR_CODES_RELEASE + ' code(s) are registered ahead of their module commit (provisional; the gate fails only if a code exists nowhere): ' + provisional.slice(0, 8).join(', ') + (provisional.length > 8 ? ', ...' : ''))
  }

  const unregistered = [...allSource.keys()].filter((code) => !registered.has(code)).sort()
  const trackedUnregistered = unregistered.filter((code) => tracked.has(code))
  if (trackedUnregistered.length) {
    const detail = trackedUnregistered.slice(0, 8).map((code) => code + ' (' + (tracked.get(code)[0] ?? '?') + ')').join(', ')
    fail('errors.source-scan', trackedUnregistered.length + ' unregistered code(s) in tracked source: ' + detail + (trackedUnregistered.length > 8 ? ', ...' : '') + '; add them to packages/advisers/lib/error-codes.js then run --update')
  } else {
    pass('errors.source-scan', tracked.size + ' distinct tracked literal(s), all registered')
  }
  const pendingOnly = unregistered.filter((code) => !tracked.has(code))
  if (pendingOnly.length) {
    info('pending unregistered code(s) in uncommitted files (will fail once committed): ' + pendingOnly.slice(0, 12).join(', ') + (pendingOnly.length > 12 ? ', ...' : ''))
  }

  if (!existsSync(registryPath)) fail('errors.registry-file', 'contracts/errors/codes.v1.json is missing; run --update')
  else if (readText(registryPath) !== generated) fail('errors.registry-file', 'contracts/errors/codes.v1.json is stale; run --update')
  else pass('errors.registry-file', 'generated file in sync')

  if (!existsSync(errorDocsPath)) fail('errors.docs', 'docs/ERROR-CODES.md is missing; run --update')
  else if (readText(errorDocsPath) !== generatedDocs) fail('errors.docs', 'docs/ERROR-CODES.md is stale; run --update')
  else pass('errors.docs', 'generated docs in sync')

  const dshText = existsSync(dshIndexPath) ? readText(dshIndexPath) : ''
  const dshProblems = []
  for (const code of Object.keys(DSH_ERROR_CODES)) {
    if (!dshText.includes(code)) dshProblems.push(code + ' not found in packages/dsh-advisers/index.js')
    if (Object.hasOwn(ERROR_CODES, code)) dshProblems.push(code + ' duplicates a CLI E_* name')
  }
  if (dshProblems.length) fail('errors.dsh-external', firstErrors(dshProblems, 4))
  else pass('errors.dsh-external', Object.keys(DSH_ERROR_CODES).length + ' external DSH codes preserved')
}

/* ------------------------------------------------------------------ */
/* --docs                                                             */
/* ------------------------------------------------------------------ */

function checkDocs() {
  const problems = []
  const versions = readJson(join(contractsDir, 'versions-v1.json'))
  const docText = existsSync(contractsDocsPath) ? readText(contractsDocsPath) : ''
  if (!docText) problems.push('docs/CONTRACTS.md is missing')
  const artifactPaths = []
  for (const artifact of Object.values(versions.artifacts ?? {})) {
    for (const rel of artifact.files ?? []) artifactPaths.push(rel)
    if (artifact.draft) artifactPaths.push(artifact.draft)
  }
  for (const rel of artifactPaths) {
    if (!existsSync(join(contractsDir, rel))) problems.push('artifact file missing: contracts/' + rel)
    if (!docText.includes(rel)) problems.push('docs/CONTRACTS.md does not mention contracts/' + rel)
  }
  for (const requiredMention of ['contracts/versions-v1.json', 'contracts/README.md', 'contracts/CONSUMERS.json', 'contracts/LICENSE', 'scripts/check-contracts.mjs', 'docs/ERROR-CODES.md']) {
    if (!docText.includes(requiredMention)) problems.push('docs/CONTRACTS.md does not mention ' + requiredMention)
  }
  if (!/not active/i.test(docText)) problems.push('docs/CONTRACTS.md must state that exit codes 4/5/6 are not active')
  if (!existsSync(errorDocsPath)) problems.push('docs/ERROR-CODES.md is missing')
  else if (!readText(errorDocsPath).includes('generated by scripts/check-contracts.mjs --update')) problems.push('docs/ERROR-CODES.md is not marked as generated')

  const expected = versions.discovery?.expected ?? {}
  const artifactVersion = (key) => versions.artifacts?.[key]?.version
  const cliSchema = readJson(join(contractsDir, 'cli/read-models-v1.schema.json'))
  const exitCodes = readJson(join(contractsDir, 'cli/exit-codes-v1.json'))
  const mcpTools = readJson(join(contractsDir, 'mcp/tools-v1.json'))
  const mcpResources = readJson(join(contractsDir, 'mcp/resources-v1.json'))
  const mcpVersions = readJson(join(contractsDir, 'mcp/versions-v1.json'))
  const petBrief = readJson(petBriefSchemaPath)
  const dshTools = new Set()
  if (existsSync(dshIndexPath)) {
    for (const match of readText(dshIndexPath).matchAll(/\bname:\s*'advisers_[a-z_]+'/g)) dshTools.add(match[0])
  }
  if (expected.cliJson !== cliSchema.version) problems.push('discovery.cliJson ' + expected.cliJson + ' != read-models version ' + cliSchema.version)
  if (expected.errors !== artifactVersion('errors')) problems.push('discovery.errors ' + expected.errors + ' != artifacts.errors.version ' + artifactVersion('errors'))
  if (expected.exitCodes !== exitCodes.version) problems.push('discovery.exitCodes ' + expected.exitCodes + ' != exit-codes version ' + exitCodes.version)
  if (expected.mcpTools !== mcpTools.version) problems.push('discovery.mcpTools ' + expected.mcpTools + ' != tools version ' + mcpTools.version)
  if (expected.mcpResources !== mcpResources.version) problems.push('discovery.mcpResources ' + expected.mcpResources + ' != resources version ' + mcpResources.version)
  if (!mcpVersions.supportedProtocolVersions.includes(expected.mcpProtocol)) problems.push('discovery.mcpProtocol ' + expected.mcpProtocol + ' is not supported by mcp/versions-v1.json')
  if (expected.petBrief !== petBrief.properties?.schemaVersion?.const) problems.push('discovery.petBrief ' + expected.petBrief + ' != docs/pet-brief schemaVersion.const')
  if (expected.dshTools !== artifactVersion('dshTools')) problems.push('discovery.dshTools ' + expected.dshTools + ' != artifacts.dshTools.version ' + artifactVersion('dshTools'))
  if (dshTools.size !== 5) problems.push('expected the frozen 5 DSH tools, found ' + dshTools.size + ' in packages/dsh-advisers/index.js')
  const consumers = JSON.parse(readText(join(contractsDir, 'CONSUMERS.json')))
  if (!Array.isArray(consumers.consumers) || consumers.consumers.length === 0) problems.push('contracts/CONSUMERS.json has no consumers')
  if (problems.length) fail('docs.consistency', firstErrors(problems, 6))
  else pass('docs.consistency', artifactPaths.length + ' artifact path(s) documented, discovery manifest agrees with artifact versions')
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const selected = new Set()
  let update = false
  let help = false
  const unknown = []
  for (const arg of argv) {
    if (arg === '--update') update = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (CHECK_FLAGS[arg]) selected.add(CHECK_FLAGS[arg])
    else unknown.push(arg)
  }
  return { selected: selected.size ? selected : new Set(ALL_CHECKS), update, help, unknown }
}

function usage() {
  console.log('usage: node scripts/check-contracts.mjs [--schema] [--vectors] [--cli] [--status] [--exit] [--mcp] [--errors] [--docs] [--update]')
  console.log('')
  console.log('Runs all checks by default. --update regenerates contracts/errors/codes.v1.json and docs/ERROR-CODES.md from packages/advisers/lib/error-codes.js.')
}

function main(argv = process.argv.slice(2)) {
  const { selected, update, help, unknown } = parseArgs(argv)
  if (help) { usage(); return 0 }
  if (unknown.length) {
    console.error('check-contracts: unknown argument(s): ' + unknown.join(' '))
    usage()
    return 1
  }
  console.log('check-contracts: contracts v' + readJson(join(contractsDir, 'versions-v1.json')).version + ' checks: ' + [...selected].join(','))
  if (update) {
    writeGenerated(registryPath, JSON.stringify(buildRegistryJson(), null, 2) + '\n')
    writeGenerated(errorDocsPath, renderErrorCodesDoc())
  }
  const runners = {
    schema: checkSchemaArtifacts,
    vectors: checkVectors,
    cli: checkCli,
    status: checkStatus,
    exit: checkExitCodes,
    mcp: checkMcp,
    errors: checkErrorRegistry,
    docs: checkDocs,
  }
  for (const check of ALL_CHECKS) {
    if (!selected.has(check)) continue
    try {
      runners[check]()
    } catch (error) {
      fail(check, 'check crashed: ' + String(error && error.stack ? error.stack.split('\n')[0] : error))
    }
  }
  const summary = 'check-contracts: ' + (failures.length ? 'FAIL (' + failures.length + ' failure(s), ' + passCount + ' checks passed' + (infoCount ? ', ' + infoCount + ' info' : '') + ')' : 'PASS (' + passCount + ' checks' + (infoCount ? ', ' + infoCount + ' info' : '') + ')')
  if (failures.length) {
    console.error('')
    for (const failure of failures) console.error('  - ' + failure)
    console.error('')
    console.error(summary)
    return 1
  }
  console.log('')
  console.log(summary)
  return 0
}

export {
  ALL_CHECKS,
  CHECK_FLAGS,
  CONTRACT_LICENSE,
  REQUIRED_SCHEMA_METADATA,
  SUPPORTED_SCHEMA_KEYWORDS,
  auditSchemaKeywords,
  buildRegistryJson,
  deepEqual,
  main,
  renderErrorCodesDoc,
  resolvePointer,
  scanErrorCodeLiterals,
  topLevelDefs,
  validateInstance,
  validateTarget,
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
