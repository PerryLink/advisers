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

export interface EmailTransport {
  send(input: { to: string; subject: string; body: string; threadId?: string }): Promise<{ id: string }>
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

  constructor(transport: EmailTransport, accountId: string) {
    this.transport = transport
    this.accountId = accountId
  }

  async start(host: LinkHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.host = undefined
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const result = await this.transport.send({
        to: message.conversationId,
        subject: 'Advisers',
        body: message.text,
        threadId: message.threadId,
      })
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
