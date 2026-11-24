/**
 * 0.5.1 (plan 92 section 4): threading-header parsing.
 *
 * The parser is pure and offline: In-Reply-To / References / Auto-Submitted are
 * reduced to bounded normalised values and every refusal is explained in
 * warnings. Link-building is the mail store's job (mail-thread-store.test.js).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_THREAD_REFERENCES,
  MAX_THREAD_REFERENCES_BYTES,
  MAX_THREAD_REFERENCE_CHARS,
  normalizeAutoSubmitted,
  normalizeMessageIdToken,
  normalizeThreadIds,
  parseMailMessage,
} from '../lib/mail-parse.js'

const BASE_HEADERS = [
  'From: 王工 <wang@acme.cn>',
  'To: me@example.com',
  'Subject: 报价',
  'Date: Thu, 12 Nov 2026 10:00:00 +0800',
]

function eml(extraHeaders = [], body = '我周五前把报价发给你。') {
  return [...BASE_HEADERS, ...extraHeaders].join('\r\n') + '\r\n\r\n' + body + '\r\n'
}

test('References: folded header, multiple ids and order are preserved', () => {
  const parsed = parseMailMessage(eml([
    'Message-ID: <reply-2@acme.cn>',
    'References: <root-0@example.com>',
    ' <orig-1@example.com>',
    ' <reply-2@acme.cn>',
  ]))
  assert.deepEqual(parsed.references, ['root-0@example.com', 'orig-1@example.com', 'reply-2@acme.cn'])
  assert.deepEqual(parsed.warnings, [])
})

test('In-Reply-To: the immediate parent (last id) is kept, angle brackets stripped', () => {
  const parsed = parseMailMessage(eml([
    'Message-ID: <reply-2@acme.cn>',
    'In-Reply-To: <orig-1@example.com>',
  ]))
  assert.equal(parsed.inReplyTo, 'orig-1@example.com')
  assert.deepEqual(parsed.references, [])
  const multi = parseMailMessage(eml(['In-Reply-To: <a@x.y> <b@x.y>']))
  assert.equal(multi.inReplyTo, 'b@x.y', 'RFC 5322 allows a list; the last id is the parent')
})

test('missing angle brackets are accepted for both headers', () => {
  const parsed = parseMailMessage(eml([
    'In-Reply-To: orig-1@example.com',
    'References: root-0@example.com orig-1@example.com',
  ]))
  assert.equal(parsed.inReplyTo, 'orig-1@example.com')
  assert.deepEqual(parsed.references, ['root-0@example.com', 'orig-1@example.com'])
  assert.deepEqual(parsed.warnings, [])
})

test('no threading headers: null / [] and no warnings', () => {
  const parsed = parseMailMessage(eml(['Message-ID: <m@x.y>']))
  assert.equal(parsed.inReplyTo, null)
  assert.deepEqual(parsed.references, [])
  assert.equal(parsed.autoSubmitted, null)
  assert.deepEqual(parsed.warnings, [])
})

test('References is bounded: count limit truncates with a warning', () => {
  const ids = Array.from({ length: MAX_THREAD_REFERENCES + 5 }, (_, index) => '<r' + index + '@x.y>')
  const parsed = parseMailMessage(eml(['References: ' + ids.join(' ')]))
  assert.equal(parsed.references.length, MAX_THREAD_REFERENCES)
  assert.deepEqual(parsed.warnings, ['references-truncated'])
  assert.equal(normalizeThreadIds(ids.join(' ')).truncated, true)
})

test('References is bounded: a single over-long id is dropped as invalid', () => {
  const long = 'a'.repeat(MAX_THREAD_REFERENCE_CHARS) + '@x.y'
  const parsed = parseMailMessage(eml(['References: <' + long + '>']))
  assert.deepEqual(parsed.references, [])
  assert.deepEqual(parsed.warnings, ['references-invalid'])
  assert.equal(normalizeMessageIdToken('<' + long + '>'), '')
})

test('References is bounded: the UTF-8 byte limit truncates the list', () => {
  const ids = Array.from({ length: 18 }, (_, index) => 'r' + index + 'x'.repeat(470) + '@example.com')
  const result = normalizeThreadIds(ids.map((id) => '<' + id + '>').join(' '))
  assert.equal(result.truncated, true)
  assert.ok(result.ids.length < ids.length)
  let bytes = 0
  for (const id of result.ids) bytes += Buffer.byteLength(id, 'utf8') + 1
  assert.ok(bytes <= MAX_THREAD_REFERENCES_BYTES)
})

test('duplicate ids are removed, junk ids are counted as invalid and explained', () => {
  const parsed = parseMailMessage(eml(['References: <a@x.y> <a@x.y> not-an-id']))
  assert.deepEqual(parsed.references, ['a@x.y'])
  assert.deepEqual(parsed.warnings, [])
  const junk = parseMailMessage(eml(['In-Reply-To: not-a-message-id']))
  assert.equal(junk.inReplyTo, null)
  assert.deepEqual(junk.warnings, ['in-reply-to-invalid'])
})

test('Auto-Submitted is lower-cased and bounded; absent means null', () => {
  const parsed = parseMailMessage(eml(['Auto-Submitted: Auto-Replied']))
  assert.equal(parsed.autoSubmitted, 'auto-replied')
  assert.equal(normalizeAutoSubmitted('  AUTO-GENERATED  '), 'auto-generated')
  assert.equal(normalizeAutoSubmitted(''), null)
  assert.equal(normalizeAutoSubmitted(null), null)
})

test('existing parse fields are unchanged by the threading additions', () => {
  const parsed = parseMailMessage(eml(['Message-ID: <m@x.y>', 'In-Reply-To: <p@x.y>']))
  assert.equal(parsed.from, '王工 <wang@acme.cn>')
  assert.equal(parsed.subject, '报价')
  assert.equal(parsed.messageId, 'm@x.y')
  assert.match(parsed.text, /周五前/)
  assert.deepEqual(parsed.attachments, [])
  assert.ok(parsed.sizeBytes > 0)
})
