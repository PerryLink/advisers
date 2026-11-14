import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { fetchImapMessages, imapQuote, imapSinceDate } from '../lib/imap.js'

function mockServer({ raw, uid = 42 }) {
  const commands = []
  const server = net.createServer((socket) => {
    let buf = ''
    socket.write('* OK mock IMAP ready\r\n')
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        const i = buf.indexOf('\r\n'); if (i < 0) break
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        commands.push(line)
        const [tag] = line.split(' ')
        if (/ LOGIN /i.test(line)) socket.write(`${tag} OK LOGIN completed\r\n`)
        else if (/ EXAMINE /i.test(line)) socket.write('* 1 EXISTS\r\n' + `${tag} OK [READ-ONLY] EXAMINE completed\r\n`)
        else if (/ UID SEARCH /i.test(line)) socket.write(`* SEARCH ${uid}\r\n${tag} OK SEARCH completed\r\n`)
        else if (/ UID FETCH /i.test(line)) {
          const bytes = Buffer.from(raw, 'utf8')
          socket.write(`* ${uid} FETCH (BODY[] {${bytes.length}}\r\n`)
          socket.write(bytes)
          socket.write(')\r\n' + `${tag} OK FETCH completed\r\n`)
        } else if (/ LOGOUT/i.test(line)) socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`)
        else socket.write(`${tag} BAD unknown\r\n`)
      }
    })
  })
  return { server, commands }
}

test('E2-T2: read-only IMAP fetches raw messages and never sends write commands', async () => {
  const raw = 'From: 王工 <wang@example.com>\r\nSubject: 报价\r\nMessage-ID: <imap-1@example.com>\r\n\r\n周五前发报价。\r\n'
  const { server, commands } = mockServer({ raw })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const messages = await fetchImapMessages({ host: '127.0.0.1', port, secure: false, user: 'me', pass: 'secret', limit: 5 })
    assert.equal(messages.length, 1)
    assert.match(messages[0].raw.toString('utf8'), /Subject: 报价/)
    assert.ok(commands.some((c) => /EXAMINE "INBOX"/.test(c)))
    assert.ok(commands.some((c) => /UID FETCH 42/.test(c)))
    for (const c of commands) assert.ok(!/ (STORE|APPEND|EXPUNGE|COPY|MOVE|DELETE) /i.test(c), `write command leaked: ${c}`)
  } finally { await new Promise((r) => server.close(r)) }
})

test('E2-T2: IMAP helpers escape credentials and compute SINCE dates', () => {
  assert.equal(imapQuote('a"b\\c'), '"a\\"b\\\\c"')
  assert.match(imapSinceDate(30, new Date('2026-11-14T00:00:00Z')), /^15-Oct-2026$/)
})
