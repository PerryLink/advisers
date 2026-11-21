import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SOURCE_TYPES,
  SOURCE_VERSION,
  isSourceV2,
  normalizeSource,
  toLegacySource,
  validateSource,
} from '../lib/source.js'

/* ------------------------------------------------------------------ *
 * v2 canonical shape: all four source types round-trip
 * ------------------------------------------------------------------ */

const V2_SAMPLES = [
  {
    type: 'conversation',
    source: {
      sourceVersion: 2,
      type: 'conversation',
      quote: '周五前把报价发我。',
      ref: 'conv_1#turn_9',
      capturedAt: '2026-11-17T09:00:00+08:00',
    },
  },
  {
    type: 'mail',
    source: {
      sourceVersion: 2,
      type: 'mail',
      quote: '请把报价发给我。',
      messageId: '<q1@example.com>',
      subject: '周五前报价',
      file: 'quote.eml',
      mime: 'text/plain; charset=utf-8',
      capturedAt: '2026-11-17T09:00:00+08:00',
    },
  },
  {
    type: 'calendar',
    source: {
      sourceVersion: 2,
      type: 'calendar',
      quote: '客户周会',
      ref: 'cal-weekly-1',
      subject: '客户周会',
      tStart: '2026-11-17T10:00:00+08:00',
      tEnd: '2026-11-17T11:00:00+08:00',
    },
  },
  {
    type: 'transcript',
    source: {
      sourceVersion: 2,
      type: 'transcript',
      quote: '周五前把报价发我。',
      file: '会议.vtt',
      speaker: '王工',
      tStart: '2026-11-17T10:00:05+08:00',
      capturedAt: '2026-11-17T10:30:00+08:00',
    },
  },
]

test('normalizeSource: source types round-trip field-for-field', () => {
  assert.equal(SOURCE_VERSION, 2)
  assert.deepEqual([...SOURCE_TYPES], ['conversation', 'mail', 'calendar', 'transcript', 'kb_chunk', 'kb_page', 'web', 'tool'])
  for (const { type, source } of V2_SAMPLES) {
    const normalized = normalizeSource(source)
    assert.deepEqual(normalized, source, type)
    assert.equal(isSourceV2(source), true, type)
    assert.deepEqual(normalizeSource(normalized), normalized, type + ' is idempotent')
    const validation = validateSource(source)
    assert.equal(validation.ok, true, type + ': ' + validation.errors.join('; '))
    assert.deepEqual(validation.errors, [], type)
    assert.deepEqual(validation.source, normalized, type)
  }
})

test('normalizeSource: unknown v1-style extension fields are preserved', () => {
  const normalized = normalizeSource({
    type: 'mail',
    messageId: '<q2@example.com>',
    subject: '报价',
    channel: 'imap',
    from: '王工 <wang@example.com>',
    uid: '42',
  })
  assert.equal(normalized.type, 'mail')
  assert.equal(normalized.messageId, '<q2@example.com>')
  // IMAP UID is not a calendar UID, so it survives as an extension instead of
  // being repurposed as ref.
  assert.equal(normalized.uid, '42')
  assert.equal(normalized.channel, 'imap')
  assert.equal(normalized.from, '王工 <wang@example.com>')
  assert.equal(normalized.ref, undefined)
})

/* ------------------------------------------------------------------ *
 * v1 -> v2 compatibility mapping
 * ------------------------------------------------------------------ */

test('normalizeSource: legacy v1 rows map into the v2 fields', () => {
  const conversation = normalizeSource({ sessionId: 'conv_1', turnId: 'turn_9', quote: '周五前发报价' })
  assert.equal(conversation.sourceVersion, 2)
  assert.equal(conversation.type, 'conversation')
  assert.equal(conversation.ref, 'conv_1#turn_9')
  assert.equal(conversation.quote, '周五前发报价')

  const turnOnly = normalizeSource({ turnId: 'turn_9', quote: '好的' })
  assert.equal(turnOnly.ref, 'legacy#turn_9')

  const mail = normalizeSource({ type: 'email', messageId: '<q3@example.com>', subject: '周报', from: '王工' })
  assert.equal(mail.type, 'mail') // legacy spelling normalised
  assert.equal(mail.messageId, '<q3@example.com>')
  assert.equal(mail.subject, '周报')
  assert.equal(mail.sourceVersion, 2)

  const calendar = normalizeSource({ type: 'calendar', uid: 'cal-1', subject: '客户周会' })
  assert.equal(calendar.ref, 'cal-1') // v1 calendar UID becomes the v2 pointer
  assert.equal(calendar.uid, undefined)

  const transcript = normalizeSource({ type: 'transcript', file: 'dir/会议.vtt', speakers: ['王工', '李四'], quote: '周五前发' })
  assert.equal(transcript.file, '会议.vtt') // only basenames are stored
  assert.equal(transcript.speaker, '王工')
  assert.equal(transcript.speakers, undefined)
})

test('validateSource: legacy rows are valid and explain the v1 mapping', () => {
  const calendar = validateSource({ type: 'calendar', uid: 'cal-1', subject: '客户周会' })
  assert.equal(calendar.ok, true)
  assert.ok(calendar.warnings.some((warning) => /legacy v1 source mapped to v2/.test(warning)))
  assert.equal(calendar.source.ref, 'cal-1')

  const legacyV1 = validateSource({ sourceVersion: 1, type: 'mail', messageId: '<q4@example.com>' })
  assert.equal(legacyV1.ok, true)
  assert.ok(legacyV1.warnings.some((warning) => /legacy v1/.test(warning)))

  const adHocType = validateSource({ type: 'user_explicit', quote: '用户说周五前发' })
  assert.equal(adHocType.ok, true) // v1 used ad-hoc types; keep them, just warn
  assert.ok(adHocType.warnings.some((warning) => /unknown source type/.test(warning)))
  assert.equal(adHocType.source.type, 'user_explicit')
})

/* ------------------------------------------------------------------ *
 * Validation failures
 * ------------------------------------------------------------------ */

test('validateSource: rejects malformed sources and unsafe file paths', () => {
  for (const raw of [null, undefined, 'source', [], 42]) {
    const result = validateSource(raw)
    assert.equal(result.ok, false)
    assert.ok(result.errors.length > 0)
  }

  const noPointer = validateSource({ type: 'mail', subject: '只有主题' })
  assert.equal(noPointer.ok, false)
  assert.ok(noPointer.errors.some((error) => /neither a pointer/.test(error)))

  const absolute = validateSource({ type: 'mail', messageId: '<q5@example.com>', file: '/home/user/quote.eml' })
  assert.equal(absolute.ok, false)
  assert.ok(absolute.errors.some((error) => /basename/.test(error)))

  const badMime = validateSource({ type: 'mail', messageId: '<q6@example.com>', mime: 'plain' })
  assert.equal(badMime.ok, false)
  assert.ok(badMime.errors.some((error) => /mime/.test(error)))

  const badTime = validateSource({
    type: 'calendar',
    ref: 'cal-2',
    tStart: '2026-11-18T10:00:00+08:00',
    tEnd: '2026-11-17T10:00:00+08:00',
  })
  assert.equal(badTime.ok, false)
  assert.ok(badTime.errors.some((error) => /tStart must not be after tEnd/.test(error)))

  const badTimestamp = validateSource({ type: 'mail', messageId: '<q7@example.com>', capturedAt: 'yesterday' })
  assert.equal(badTimestamp.ok, false)
  assert.ok(badTimestamp.errors.some((error) => /capturedAt/.test(error)))

  const badType = validateSource({ type: 42, messageId: '<q8@example.com>' })
  assert.equal(badType.ok, false)
  assert.ok(badType.errors.some((error) => /type must be a string/.test(error)))

  const emptyType = validateSource({ type: '  ', messageId: '<q9@example.com>' })
  assert.equal(emptyType.ok, false)
  assert.ok(emptyType.errors.some((error) => /type must not be empty/.test(error)))

  const unknownVersion = validateSource({ sourceVersion: 3, type: 'mail', messageId: '<q10@example.com>' })
  assert.equal(unknownVersion.ok, true)
  assert.ok(unknownVersion.warnings.some((warning) => /unknown sourceVersion 3/.test(warning)))
})

/* ------------------------------------------------------------------ *
 * v2 -> v1 downgrade for not-yet-migrated consumers
 * ------------------------------------------------------------------ */

test('toLegacySource: lossy downgrade keeps every v1 field', () => {
  for (const { type, source } of V2_SAMPLES) {
    const legacy = toLegacySource(source)
    assert.equal(legacy.sourceVersion, undefined, type)
    assert.equal(legacy.type, type)
    for (const field of ['quote', 'ref', 'messageId', 'subject', 'file', 'capturedAt']) {
      if (source[field] !== undefined) assert.equal(legacy[field], source[field], type + '.' + field)
    }
    // v2-only fields do not exist in the v1 schema.
    assert.equal(legacy.mime, undefined, type)
    assert.equal(legacy.tStart, undefined, type)
    assert.equal(legacy.tEnd, undefined, type)
    assert.equal(legacy.speaker, undefined, type)

    // v1-specific spellings are regenerated for old readers.
    if (type === 'calendar') assert.equal(legacy.uid, source.ref)
    if (type === 'transcript') assert.deepEqual(legacy.speakers, [source.speaker])

    // The v1 fields survive a v2 -> v1 -> v2 round trip.
    const restored = normalizeSource(legacy)
    for (const field of ['type', 'quote', 'ref', 'messageId', 'subject', 'file', 'capturedAt']) {
      if (legacy[field] !== undefined) assert.equal(restored[field], legacy[field], type + '.' + field)
    }
  }
  assert.equal(toLegacySource(null), null)
  assert.equal(toLegacySource('mail'), null)
})
