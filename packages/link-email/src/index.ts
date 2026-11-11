import type {
  DeliveryResult,
  InboundEvent,
  IngestResult,
  LinkCapabilities,
  LinkHost,
  LinkProvider,
  OutboundMessage,
} from '../../core/src/link.ts'

export interface EmailMessage {
  from: string
  fromName?: string
  subject: string
  body: string
  messageId: string
  threadId?: string
}

export interface EmailDraftInput {
  to: string
  subject: string
  body: string
  threadId?: string
  inReplyTo?: string
  references?: string[]
  /** Deterministic key so a retry does not create a second draft. */
  idempotencyKey?: string
  messageId?: string
}

export interface EmailTransport {
  send(input: EmailDraftInput): Promise<{ id: string }>
}

/** A draft-only transport never calls SMTP; it appends to the Drafts mailbox. */
export interface EmailDraftTransport extends EmailTransport {
  draft(input: EmailDraftInput): Promise<{ id: string }>
}

/** Pull-based source: polls IMAP and hands parsed mail to the Link. */
export interface EmailSource {
  start(onMessage: (message: EmailMessage) => Promise<void>): Promise<void>
  stop(): Promise<void>
}

export interface EmailLinkOptions {
  /** Default true: create a Draft, never send. */
  draftOnly?: boolean
  source?: EmailSource
}

/**
 * The email link is deliberately the first adapter:
 * - no platform approval, no admin consent;
 * - works with any IM that can forward or share to an email address;
 * - the user explicitly forwards, so the privacy story is clean.
 */
export class EmailLink implements LinkProvider {
  readonly id = 'email'
  readonly capabilities: LinkCapabilities = {
    threads: true,
    cards: false,
    media: true,
    approvals: false,
  }

  private host?: LinkHost
  private readonly transport: EmailTransport
  private readonly accountId: string
  private readonly options: EmailLinkOptions

  constructor(transport: EmailTransport, accountId: string, options: EmailLinkOptions = {}) {
    this.transport = transport
    this.accountId = accountId
    this.options = { draftOnly: true, ...options }
  }

  async start(host: LinkHost): Promise<void> {
    this.host = host
    if (this.options.source) {
      await this.options.source.start(async (message) => { await this.receive(message) })
    }
  }

  async stop(): Promise<void> {
    if (this.options.source) await this.options.source.stop()
    this.host = undefined
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const input: EmailDraftInput = {
        to: message.conversationId,
        subject: message.threadId ? 'Re: Advisers' : 'Advisers',
        body: message.text,
        threadId: message.threadId,
        idempotencyKey: message.idempotencyKey,
      }
      const draft = this.transport as Partial<EmailDraftTransport>
      const result = this.options.draftOnly !== false && draft.draft
        ? await draft.draft(input)
        : await this.transport.send(input)
      return { ok: true, messageId: result.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Called by the email poller/webhook after it has parsed a message. */
  async receive(message: EmailMessage): Promise<IngestResult> {
    if (!this.host) throw new Error('email link is not started')
    const event: InboundEvent = {
      linkId: this.id,
      accountId: this.accountId,
      conversationId: message.from,
      threadId: message.threadId,
      messageId: message.messageId,
      dedupeKey: message.messageId,
      conversationType: 'email',
      addressed: true,
      sender: { id: message.from, name: message.fromName },
      text: `${message.subject}\n\n${message.body}`,
      timestamp: new Date().toISOString(),
      raw: message,
    }
    return this.host.ingest(event)
  }
}
