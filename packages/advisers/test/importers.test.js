import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dedupeKey,
  parseEml,
  parseIcs,
  parseMbox,
  parseTranscript,
  toCaptureInput,
} from '../lib/importers.js'

/* ------------------------------------------------------------------ *
 * Inline fixtures (no files on disk, no network)
 * ------------------------------------------------------------------ */

// Subject: 周五前报价   Body: 王工：周五前把报价发我。
const QP_EMAIL = [
  'From: =?UTF-8?B?546L5bel?= <wang@example.com>',
  'To: =?UTF-8?B?5p2O5Zub?= <li@example.com>',
  'Subject: =?UTF-8?B?5ZGo5LqU5YmN5oql5Lu3?=',
  'Date: Fri, 14 Nov 2026 09:00:00 +0800',
  'Message-ID: <q1@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '=E7=8E=8B=E5=B7=A5=EF=BC=9A=E5=91=A8=E4=BA=94=E5=89=8D=E6=8A=8A=E6=8A=',
  '=A5=E4=BB=B7=E5=8F=91=E6=88=91=E3=80=82',
].join('\n')

// Same Chinese text, base64 encoded and wrapped on two lines.
const BASE64_EMAIL = [
  'From: "李四" <li@example.com>',
  'To: wang@example.com',
  'Subject: =?UTF-8?B?5ZGo5LqU5YmN5oql5Lu3?=',
  'Date: Fri, 14 Nov 2026 10:00:00 +0800',
  'Message-ID: <b64@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  '57qv5paH5pys5q2j5paH77ya5ZGo5LiA5YmN',
  '5Y+R5ZCI5ZCM44CC',
].join('\n')

// Body: <p>HTML &amp; 正文 &lt;测试&gt; &nbsp;结束</p>
const HTML_BODY_B64 = 'PHA+SFRNTCAmYW1wOyDmraPmlocgJmx0O+a1i+ivlSZndDsgJm5ic3A757uT5p2fPC9wPg=='

const MULTIPART_EMAIL = [
  'From: =?UTF-8?B?546L5bel?= <wang@example.com>',
  'To: li@example.com',
  'Subject: Multipart 测试',
  'Date: Fri, 14 Nov 2026 11:00:00 +0800',
  'Message-ID: <multi@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="bnd-42"',
  '',
  '--bnd-42',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  '546L5bel77ya5ZGo5LqU5YmN5oqK5oql5Lu35Y+R5oiR44CC',
  '--bnd-42',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  HTML_BODY_B64,
  '--bnd-42--',
].join('\n')

const MBOX = [
  'From wang@example.com Fri Nov 14 09:00:00 2026',
  'From: wang@example.com',
  'To: li@example.com',
  'Subject: 第一封',
  'Date: Fri, 14 Nov 2026 09:00:00 +0800',
  'Message-ID: <mbox-1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  '56ys5LiA5bCB5q2j5paH',
  '',
  'From li@example.com Fri Nov 14 10:00:00 2026',
  'From: li@example.com',
  'To: wang@example.com',
  'Subject: 第二封',
  'Date: Fri, 14 Nov 2026 10:00:00 +0800',
  'Message-ID: <mbox-2@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '第二封正文直接 UTF-8',
].join('\n')

// DTSTART/DTEND in Asia/Shanghai, folded SUMMARY, escaped DESCRIPTION, RRULE,
// a nested VALARM (must not leak its DESCRIPTION), plus all-day and UTC events.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//advisers-test//CN',
  'BEGIN:VEVENT',
  'UID:evt-tzid@example.com',
  'DTSTAMP:20261114T010000Z',
  'DTSTART;TZID=Asia/Shanghai:20261114T100000',
  'DTEND;TZID=Asia/Shanghai:20261114T110000',
  'SUMMARY:周会 - 报',
  ' 价评审',
  'DESCRIPTION:第一行\\n第二行\\, 含逗号',
  'LOCATION:会议室 ',
  '\tA',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:提醒：开会',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-allday@example.com',
  'DTSTART;VALUE=DATE:20261201',
  'SUMMARY:全天培训',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-utc@example.com',
  'DTSTART:20261202T030000Z',
  'DTEND:20261202T040000Z',
  'SUMMARY:UTC 事件',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const VTT = [
  'WEBVTT',
  '',
  'NOTE 这是注释',
  '',
  'cue-1',
  '00:00:01.500 --> 00:00:03.000 align:start position:0%',
  '<v 王工>周五前把报价发我。',
  '',
  '00:00:03.000 --> 00:00:05.250',
  '<b>李四</b>: 收到&amp;我来发',
].join('\n')

const SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,500',
  '王工：周五前把报价发我。',
  '',
  '2',
  '00:00:02,500 --> 00:00:05,000',
  '我：好的。',
].join('\r\n')

/* ------------------------------------------------------------------ *
 * parseEml
 * ------------------------------------------------------------------ */

test('parseEml: RFC 2047 headers, quoted-printable Chinese body and soft line break', () => {
  const parsed = parseEml(QP_EMAIL)
  assert.equal(parsed.from, '王工 <wang@example.com>')
  assert.equal(parsed.to, '李四 <li@example.com>')
  assert.equal(parsed.subject, '周五前报价')
  assert.equal(parsed.date, 'Fri, 14 Nov 2026 09:00:00 +0800')
  assert.equal(parsed.messageId, 'q1@example.com')
  assert.equal(parsed.text, '王工：周五前把报价发我。')
  assert.equal(parsed.html, undefined)
  assert.deepEqual(parsed.warnings, [])

  // CRLF input must parse identically (RFC 822 line endings).
  const crlf = parseEml(QP_EMAIL.replace(/\n/g, '\r\n'))
  assert.equal(crlf.subject, parsed.subject)
  assert.equal(crlf.text, parsed.text)
  assert.equal(crlf.messageId, parsed.messageId)
})

test('parseEml: base64 body with wrapped lines', () => {
  const parsed = parseEml(BASE64_EMAIL)
  assert.equal(parsed.from, '"李四" <li@example.com>')
  assert.equal(parsed.text, '纯文本正文：周一前发合同。')
  assert.equal(parsed.messageId, 'b64@example.com')
  assert.deepEqual(parsed.warnings, [])
})

test('parseEml: multipart/alternative keeps text/plain and exposes the HTML part', () => {
  const parsed = parseEml(MULTIPART_EMAIL)
  assert.equal(parsed.subject, 'Multipart 测试')
  assert.equal(parsed.text, '王工：周五前把报价发我。')
  assert.ok(parsed.html.includes('<p>'))
  assert.match(parsed.html, /&amp;/)
  assert.deepEqual(parsed.warnings, [])
})

test('parseEml: HTML-only body is tag-stripped and entity-decoded', () => {
  const htmlOnly = [
    'From: noreply@example.com',
    'Subject: html only',
    'Message-ID: <html@example.com>',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    HTML_BODY_B64,
  ].join('\n')
  const parsed = parseEml(htmlOnly)
  assert.equal(parsed.text, 'HTML & 正文 <测试> 结束')
  assert.ok(!parsed.text.includes('<p>'))
  assert.match(parsed.html, /<p>/)

  const numeric = [
    'Subject: numeric entity',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>你好&#xFF01;</p>',
  ].join('\n')
  assert.equal(parseEml(numeric).text, '你好！')
})

test('parseEml: encoding failures and missing bodies return empty text with warnings', () => {
  const noBody = ['From: a@example.com', 'Subject: empty', 'Message-ID: <empty@example.com>', ''].join('\n')
  const empty = parseEml(noBody)
  assert.equal(empty.text, '')
  assert.ok(empty.warnings.length > 0)
  assert.ok(empty.warnings.includes('message has no readable text body'))

  const badCharset = [
    'Subject: bad charset',
    'Content-Type: text/plain; charset=x-no-such-charset',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=E4=BD=A0=E5=A5=BD',
  ].join('\n')
  const charsetResult = parseEml(badCharset)
  assert.equal(charsetResult.text, '')
  assert.ok(charsetResult.warnings.some((warning) => warning.startsWith('unsupported charset:')))

  const badBase64 = [
    'Subject: bad base64',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    '!!!!not-base64!!!!',
  ].join('\n')
  const base64Result = parseEml(badBase64)
  assert.equal(base64Result.text, '')
  assert.ok(base64Result.warnings.includes('invalid base64 body'))

  assert.deepEqual(parseEml('').text, '')
  assert.ok(Array.isArray(parseEml('').warnings))
  assert.equal(parseEml(undefined).text, '')
  assert.ok(Array.isArray(parseEml(undefined).warnings))
})

/* ------------------------------------------------------------------ *
 * parseMbox
 * ------------------------------------------------------------------ */

test('parseMbox: splits on ^From lines and parses each message', () => {
  const messages = parseMbox(MBOX)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].subject, '第一封')
  assert.equal(messages[0].text, '第一封正文')
  assert.equal(messages[0].messageId, 'mbox-1@example.com')
  assert.equal(messages[1].subject, '第二封')
  assert.equal(messages[1].text, '第二封正文直接 UTF-8')
  assert.equal(messages[1].messageId, 'mbox-2@example.com')
  assert.deepEqual(parseMbox('  \n'), [])
})

/* ------------------------------------------------------------------ *
 * parseIcs
 * ------------------------------------------------------------------ */

test('parseIcs: unfolds continuation lines, keeps TZID literal and RRULE raw', () => {
  const events = parseIcs(ICS)
  assert.equal(events.length, 3)

  const [weekly, allDay, utc] = events
  assert.equal(weekly.uid, 'evt-tzid@example.com')
  assert.equal(weekly.summary, '周会 - 报价评审')
  assert.equal(weekly.start, '2026-11-14T10:00:00')
  assert.equal(weekly.end, '2026-11-14T11:00:00')
  assert.equal(weekly.tzid, 'Asia/Shanghai')
  assert.equal(weekly.allDay, false)
  assert.equal(weekly.description, '第一行\n第二行, 含逗号')
  assert.equal(weekly.location, '会议室 A')
  assert.equal(weekly.rrule, 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')
  assert.ok(!weekly.description.includes('提醒')) // VALARM DESCRIPTION must not leak

  assert.equal(allDay.uid, 'evt-allday@example.com')
  assert.equal(allDay.start, '2026-12-01')
  assert.equal(allDay.end, null)
  assert.equal(allDay.allDay, true)

  assert.equal(utc.summary, 'UTC 事件')
  assert.equal(utc.start, '2026-12-02T03:00:00Z')
  assert.equal(utc.end, '2026-12-02T04:00:00Z')
  assert.equal(utc.tzid, null)
})

test('parseIcs: structurally invalid input throws Error', () => {
  assert.throws(() => parseIcs(''), /empty input/)
  assert.throws(() => parseIcs(42), /expected a string/)
  assert.throws(() => parseIcs('BEGIN:VEVENT\nUID:x\nEND:VEVENT'), /missing BEGIN:VCALENDAR/)
  assert.throws(() => parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nEND:VCALENDAR'), /unterminated VEVENT/)
  assert.throws(() => parseIcs('BEGIN:VCALENDAR\nEND:VEVENT\nEND:VCALENDAR'), /END:VEVENT without BEGIN:VEVENT/)
  assert.deepEqual(parseIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), [])
})

/* ------------------------------------------------------------------ *
 * parseTranscript
 * ------------------------------------------------------------------ */

test('parseTranscript: WebVTT cues, voice speaker and entities', () => {
  const parsed = parseTranscript(VTT)
  assert.equal(parsed.segments.length, 2)
  assert.deepEqual(parsed.segments[0], {
    start: 1.5,
    end: 3,
    speaker: '王工',
    text: '周五前把报价发我。',
  })
  assert.deepEqual(parsed.segments[1], {
    start: 3,
    end: 5.25,
    speaker: '李四',
    text: '收到&我来发',
  })
  assert.equal(parsed.text, '周五前把报价发我。\n收到&我来发')
})

test('parseTranscript: WebVTT short (MM:SS.mmm) timestamps', () => {
  const parsed = parseTranscript('WEBVTT\n\n00:01.250 --> 00:02.750\n短时间戳')
  assert.equal(parsed.segments.length, 1)
  assert.equal(parsed.segments[0].start, 1.25)
  assert.equal(parsed.segments[0].end, 2.75)
  assert.equal(parsed.segments[0].text, '短时间戳')
})

test('parseTranscript: SubRip cues with comma milliseconds and speaker prefixes', () => {
  const parsed = parseTranscript(SRT)
  assert.equal(parsed.segments.length, 2)
  assert.deepEqual(parsed.segments[0], {
    start: 0,
    end: 2.5,
    speaker: '王工',
    text: '周五前把报价发我。',
  })
  assert.deepEqual(parsed.segments[1], {
    start: 2.5,
    end: 5,
    speaker: '我',
    text: '好的。',
  })
})

test('parseTranscript: plain text keeps the whole text and infers speakers', () => {
  const plain = '王工：周五前把报价发我。\n我：好的，我周五前发。'
  const parsed = parseTranscript(plain)
  assert.equal(parsed.text, plain)
  assert.equal(parsed.segments.length, 2)
  assert.equal(parsed.segments[0].speaker, '王工')
  assert.equal(parsed.segments[1].speaker, '我')
  assert.equal(parsed.segments[1].text, '好的，我周五前发。')

  const noSpeaker = parseTranscript('这是一段没有时间戳的转写。')
  assert.equal(noSpeaker.text, '这是一段没有时间戳的转写。')
  assert.deepEqual(noSpeaker.segments, [{ text: '这是一段没有时间戳的转写。' }])

  assert.deepEqual(parseTranscript(''), { text: '', segments: [] })
})

/* ------------------------------------------------------------------ *
 * toCaptureInput
 * ------------------------------------------------------------------ */

test('toCaptureInput: normalises email metadata', () => {
  const input = toCaptureInput(parseEml(QP_EMAIL), { source: 'email' })
  assert.equal(input.source, 'email')
  assert.equal(input.text, '王工：周五前把报价发我。')
  assert.deepEqual(input.meta, {
    subject: '周五前报价',
    from: '王工 <wang@example.com>',
    date: 'Fri, 14 Nov 2026 09:00:00 +0800',
    messageId: 'q1@example.com',
  })
})

test('toCaptureInput: normalises calendar events', () => {
  const event = parseIcs(ICS)[0]
  const input = toCaptureInput(event, { source: 'calendar' })
  assert.equal(input.source, 'calendar')
  assert.match(input.text, /摘要：周会 - 报价评审/)
  assert.match(input.text, /时间：2026-11-14T10:00:00 ~ 2026-11-14T11:00:00 \(Asia\/Shanghai\)/)
  assert.equal(input.meta.uid, 'evt-tzid@example.com')
  assert.equal(input.meta.summary, '周会 - 报价评审')
  assert.equal(input.meta.start, '2026-11-14T10:00:00')
  assert.equal(input.meta.tzid, 'Asia/Shanghai')
  assert.equal(input.meta.rrule, 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')
})

test('toCaptureInput: normalises transcripts and infers sources', () => {
  const input = toCaptureInput(parseTranscript(VTT), { source: 'meeting' })
  assert.equal(input.source, 'meeting')
  assert.deepEqual(input.meta.speakers, ['王工', '李四'])
  assert.equal(input.meta.segments.length, 2)
  assert.equal(input.text, '周五前把报价发我。\n收到&我来发')

  assert.equal(toCaptureInput(parseEml(QP_EMAIL)).source, 'email')
  assert.equal(toCaptureInput(parseIcs(ICS)[0]).source, 'calendar')
  assert.equal(toCaptureInput(parseTranscript(VTT)).source, 'transcript')
})

test('toCaptureInput: collapses parser arrays into one input', () => {
  const input = toCaptureInput(parseMbox(MBOX), { source: 'email' })
  assert.equal(input.source, 'email')
  assert.match(input.text, /第一封正文/)
  assert.match(input.text, /第二封正文直接 UTF-8/)
  assert.equal(input.meta.count, 2)
  assert.equal(input.meta.items.length, 2)
  assert.equal(input.meta.items[0].messageId, 'mbox-1@example.com')
})

/* ------------------------------------------------------------------ *
 * dedupeKey
 * ------------------------------------------------------------------ */

test('dedupeKey: sha256 key is stable and prefers Message-ID', () => {
  const first = parseEml(QP_EMAIL)
  const second = parseEml(QP_EMAIL)
  const key = dedupeKey('email', first)
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(key, dedupeKey('email', second))
  // Message-ID wins over body text.
  assert.equal(key, dedupeKey('email', { ...first, text: '改写的正文' }))
  // Different source or different Message-ID => different key.
  assert.notEqual(key, dedupeKey('meeting', first))
  assert.notEqual(key, dedupeKey('email', parseEml(BASE64_EMAIL)))
})

test('dedupeKey: uid wins for calendar events, text fallback for transcripts', () => {
  const events = parseIcs(ICS)
  assert.equal(
    dedupeKey('calendar', events[0]),
    dedupeKey('calendar', { ...events[0], summary: '改过的摘要' }),
  )
  assert.notEqual(dedupeKey('calendar', events[0]), dedupeKey('calendar', events[1]))

  const transcript = parseTranscript(VTT)
  assert.equal(dedupeKey('transcript', transcript), dedupeKey('transcript', parseTranscript(VTT)))
  assert.notEqual(dedupeKey('transcript', transcript), dedupeKey('transcript', '别的转写'))

  // Whitespace-only differences do not change a text-based key.
  assert.equal(dedupeKey('email', { text: ' 同文 ' }), dedupeKey('email', { text: '同文' }))
})
