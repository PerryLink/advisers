import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { EmailDraftInput, EmailDraftTransport, EmailMessage, EmailSource } from './index.ts'

export interface ImapConfig {
  host: string
  port?: number
  secure?: boolean
  user: string
  pass: string
  /** Default INBOX. */
  mailbox?: string
  /** Default Drafts. */
  draftsMailbox?: string
  from?: string
  pollMs?: number
  /** How many recent messages to consider on first poll. */
  lookback?: number
  /** Persist {uidValidity,lastUid}; required for restart-safe ingestion. */
  cursorFile?: string
}

export interface ParsedMailLike {
  messageId?: string
  subject?: string
  text?: string
  html?: string | false
  from?: { value?: Array<{ address?: string; name?: string }> }
  inReplyTo?: string
  references?: string | string[]
}

function header(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`
}

/** Build a minimal UTF-8 MIME message without a mail library. */
export function buildRawEmail(input: EmailDraftInput, from: string, messageId?: string): Buffer {
  const lines = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${header(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]
  if (messageId) lines.push(`Message-ID: ${messageId}`)
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`)
  if (input.references?.length) lines.push(`References: ${input.references.join(' ')}`)
  lines.push('', Buffer.from(input.body, 'utf8').toString('base64'))
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

export function mapParsed(parsed: ParsedMailLike, fallbackThread?: string): EmailMessage {
  const from = parsed.from?.value?.[0]
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []
  return {
    from: from?.address ?? 'unknown@invalid',
    fromName: from?.name,
    subject: parsed.subject ?? '(no subject)',
    body: parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : ''),
    messageId: parsed.messageId ?? `imap-${Date.now()}`,
    threadId: parsed.inReplyTo ?? references[0] ?? fallbackThread,
  }
}

export class ImapSource implements EmailSource {
  private readonly config: ImapConfig
  private client?: ImapFlow
  private timer?: NodeJS.Timeout
  private lastUid = 0
  private uidValidity?: string
  private stopped = false

  constructor(config: ImapConfig) {
    this.config = config
    if (config.cursorFile && existsSync(config.cursorFile)) {
      try {
        const cursor = JSON.parse(readFileSync(config.cursorFile, 'utf8')) as { uidValidity?: string; lastUid?: number }
        this.uidValidity = cursor.uidValidity
        this.lastUid = cursor.lastUid ?? 0
      } catch {
        // A corrupt cursor is treated as empty; dedupe protects the host.
      }
    }
  }

  private saveCursor(): void {
    if (!this.config.cursorFile) return
    mkdirSync(dirname(this.config.cursorFile), { recursive: true })
    writeFileSync(this.config.cursorFile, JSON.stringify({ uidValidity: this.uidValidity, lastUid: this.lastUid }))
  }

  async start(onMessage: (message: EmailMessage) => Promise<void>): Promise<void> {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port ?? 993,
      secure: this.config.secure ?? true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    })
    await this.client.connect()
    await this.poll(onMessage)
    this.timer = setInterval(() => {
      void this.poll(onMessage).catch(() => undefined)
    }, this.config.pollMs ?? 60_000)
    this.timer.unref?.()
  }

  async poll(onMessage: (message: EmailMessage) => Promise<void>): Promise<void> {
    if (!this.client || this.stopped) return
    const lock = await this.client.getMailboxLock(this.config.mailbox ?? 'INBOX', { readOnly: true })
    try {
      const mailbox = this.client.mailbox
      const currentUidValidity = typeof mailbox === 'object' && mailbox ? String(mailbox.uidValidity) : undefined
      if (currentUidValidity && this.uidValidity && currentUidValidity !== this.uidValidity) {
        this.lastUid = 0
      }
      this.uidValidity = currentUidValidity
      const uidNext = typeof mailbox === 'object' && mailbox ? mailbox.uidNext : 1
      if (!this.lastUid) this.lastUid = Math.max(0, uidNext - (this.config.lookback ?? 20))
      const range = `${this.lastUid + 1}:*`
      for await (const msg of this.client.fetch(range, { uid: true, source: true }, { uid: true })) {
        if (typeof msg.uid !== 'number' || msg.uid <= this.lastUid) continue
        if (!msg.source) continue
        const parsed = (await simpleParser(msg.source)) as ParsedMailLike
        await onMessage(mapParsed(parsed, `imap-${msg.uid}`))
        this.lastUid = msg.uid
        this.saveCursor()
      }
    } finally {
      lock.release()
      this.saveCursor()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.client) await this.client.logout().catch(() => undefined)
    this.client = undefined
  }
}

/** Appends to Drafts; never calls SMTP. */
export class ImapDraftTransport implements EmailDraftTransport {
  private readonly config: ImapConfig

  constructor(config: ImapConfig) {
    this.config = config
  }

  async draft(input: EmailDraftInput): Promise<{ id: string }> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port ?? 993,
      secure: this.config.secure ?? true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    })
    await client.connect()
    try {
      const key = input.idempotencyKey ?? `${Date.now()}-${Math.random()}`
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 24)
      const messageId = input.messageId ?? `<advisers-${hash}@advisers.local>`
      const raw = buildRawEmail(input, this.config.from ?? this.config.user, messageId)
      let drafts = this.config.draftsMailbox
      if (!drafts) {
        const boxes = await client.list()
        drafts = boxes.find((box) => box.specialUse?.includes('\\Drafts'))?.path ?? 'Drafts'
      }
      const existing = await client.search({ header: { 'Message-ID': messageId } }, { uid: true })
      if (Array.isArray(existing) && existing.length) return { id: `draft-${existing[0]}` }
      const result = await client.append(drafts, raw, ['\\Draft'])
      return { id: `draft-${result && 'uid' in result ? result.uid : messageId}` }
    } finally {
      await client.logout().catch(() => undefined)
    }
  }

  async send(): Promise<never> {
    throw new Error('email is draft-only; use draft() and a human send action')
  }
}
