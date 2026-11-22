/**
 * 0.5.0 (WF5 050-U1a): `advisers help <topic>` content source.
 *
 * These are pure-module assertions: no HOME is read, no command is executed by
 * the module, and the Chinese alias must render byte-identical bytes to the
 * canonical topic. The CLI-level matrix (exit codes, stdout empty on unknown,
 * --help short-circuit before the TOS gate) is bin's test
 * (test/bin-050-help.test.js); a short spawn here proves the module really is
 * side-effect free on a byte-empty home.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  HELP_TOPIC_ALIASES,
  HELP_TOPIC_IDS,
  helpListLines,
  helpTopicLines,
  listHelpTopics,
  renderHelpTopic,
  resolveHelpRequest,
  resolveHelpTopic,
} from '../lib/help-topics.js'
import { HELP_USAGE_LINES } from '../lib/help-usage.js'

const ANSI = /\u001b\[/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

test('ten canonical topics with a complete, bijective Chinese alias table', () => {
  assert.equal(HELP_TOPIC_IDS.length, 10)
  assert.deepEqual(HELP_TOPIC_IDS, ['start', 'quote', 'remind', 'deliver', 'receipt', 'mail', 'kb', 'privacy', 'reach', 'errors'])
  const ids = Object.values(HELP_TOPIC_ALIASES)
  assert.deepEqual([...new Set(ids)].sort(), [...HELP_TOPIC_IDS].sort(), 'every canonical topic has exactly one alias')
  for (const alias of Object.keys(HELP_TOPIC_ALIASES)) {
    assert.equal(Object.keys(HELP_TOPIC_ALIASES).filter((other) => HELP_TOPIC_ALIASES[other] === HELP_TOPIC_ALIASES[alias]).length, 1)
    assert.match(alias, /^[\u4e00-\u9fff]{2,4}$/)
  }
})

test('every topic page is short, plain text with three commands, one next step and a doc pointer', () => {
  for (const id of HELP_TOPIC_IDS) {
    const lines = helpTopicLines(id)
    assert.ok(lines.length > 6 && lines.length <= 20, id + ' must be <= 20 lines (got ' + lines.length + ')')
    const text = lines.join('\n')
    assert.doesNotMatch(text, ANSI, id + ' must not contain ANSI escapes')
    assert.doesNotMatch(text, CONTROL, id + ' must not contain control characters')
    assert.ok(lines[0].startsWith('主题：'), id + ' first line is the topic header')
    assert.ok(lines[0].includes('（' + id + '）'), id + ' first line names the canonical id')
    const commandLines = lines.filter((line) => line.startsWith('  advisers '))
    assert.ok(commandLines.length >= 3, id + ' must list >= 3 command lines')
    assert.ok(lines.some((line) => line.startsWith('下一步：advisers help ')), id + ' must end with a next step')
    assert.ok(lines.some((line) => line.includes('安装包不含 docs')), id + ' must note that npm ships no docs/')
  }
})

test('a topic and its Chinese alias render byte-identical pages', () => {
  for (const [alias, id] of Object.entries(HELP_TOPIC_ALIASES)) {
    const canonical = renderHelpTopic(id)
    const localized = renderHelpTopic(alias)
    assert.equal(typeof canonical, 'string')
    assert.equal(localized, canonical, id + ' vs ' + alias + ' must be byte-identical')
    assert.equal(resolveHelpTopic(alias).alias, true)
    assert.equal(resolveHelpTopic(id).alias, false)
  }
})

test('resolveHelpTopic trims defensively and rejects unknown/empty/non-string topics', () => {
  assert.deepEqual(resolveHelpTopic(' quote '), { id: 'quote', alias: false })
  assert.deepEqual(resolveHelpTopic('\uFEFF报价'), { id: 'quote', alias: true })
  for (const value of ['', '   ', 'nope', 'QUOTE', null, undefined, 42, {}]) {
    assert.equal(resolveHelpTopic(value), null, JSON.stringify(value) + ' must not resolve')
  }
  assert.equal(renderHelpTopic('nope'), null)
  assert.throws(() => helpTopicLines('nope'), /unknown help topic/)
})

test('listHelpTopics and helpListLines expose all topics for help --list', () => {
  const topics = listHelpTopics()
  assert.equal(topics.length, 10)
  for (const topic of topics) {
    assert.ok(HELP_TOPIC_IDS.includes(topic.id))
    assert.equal(typeof topic.title, 'string')
    assert.ok(topic.title.length > 0)
    assert.equal(topic.aliases.length, 1)
    assert.equal(HELP_TOPIC_ALIASES[topic.aliases[0]], topic.id)
  }
  const lines = helpListLines()
  assert.ok(lines.length >= 12, 'header + 10 topics + usage line')
  for (const line of lines) {
    assert.doesNotMatch(line, ANSI)
    assert.doesNotMatch(line, CONTROL)
  }
  for (const id of HELP_TOPIC_IDS) assert.ok(lines.some((line) => line.includes(id)), 'help --list must name ' + id)
  assert.ok(lines.some((line) => line.includes('上手')), 'help --list must show the Chinese aliases')
})

test('resolveHelpRequest: topic/alias wins, then the longest known command usage, then unknown', () => {
  const quote = resolveHelpRequest(['报价'])
  assert.equal(quote.kind, 'topic')
  assert.equal(quote.topicId, 'quote')
  assert.equal(quote.text, renderHelpTopic('quote'))

  const commitAdd = resolveHelpRequest(['commit', 'add'])
  assert.equal(commitAdd.kind, 'usage')
  assert.equal(commitAdd.text, HELP_USAGE_LINES.get('commit add'))

  // Topic ids deliberately win over same-named commands (124 §4 / plan-review F13).
  assert.equal(resolveHelpRequest(['remind']).kind, 'topic')
  assert.equal(resolveHelpRequest(['kb']).kind, 'topic')

  const deliveriesUsage = resolveHelpRequest(['deliveries'])
  assert.equal(deliveriesUsage.kind, 'usage')
  assert.equal(deliveriesUsage.text, HELP_USAGE_LINES.get('deliveries'))

  // Two-token topic wins over a same-prefix command path.
  assert.equal(resolveHelpRequest(['quote', 'x']).kind, 'topic')
  assert.deepEqual(resolveHelpRequest(['nope']), { kind: 'unknown' })
  assert.deepEqual(resolveHelpRequest([]), { kind: 'unknown' })
  assert.deepEqual(resolveHelpRequest(['--list']), { kind: 'unknown' })
  // Unknown paths do not invent a usage line.
  assert.equal(resolveHelpRequest(['nonsense-command']).kind, 'unknown')
})

test('rendering help topics is side-effect free on a byte-empty HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'advisers-help-topics-'))
  const emptyHome = join(home, 'fresh-home')
  try {
    const script = [
      "import { renderHelpTopic, resolveHelpRequest } from './lib/help-topics.js'",
      "const a = renderHelpTopic('quote')",
      "const b = renderHelpTopic('报价')",
      "if (a !== b || !a) { console.error('mismatch'); process.exit(2) }",
      "process.stdout.write(String(a.length))",
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, ADVISERS_HOME: emptyHome, ADVISERS_NO_MODEL: '1' },
      encoding: 'utf8',
      input: '',
      timeout: 30000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(Number(result.stdout) > 0)
    assert.equal(existsSync(emptyHome), false, 'help topics must not create ADVISERS_HOME')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

import { fileURLToPath } from 'node:url'
