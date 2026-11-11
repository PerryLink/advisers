import type {
  DeliveryResult,
  InboundEvent,
  IngestResult,
  LinkCapabilities,
  LinkHost,
  LinkProvider,
  OutboundMessage,
} from '../../core/src/link.ts'

export interface FeishuMessage {
  openId: string
  chatId: string
  messageId: string
  threadId?: string
  text: string
  chatType?: 'p2p' | 'group'
  mentionedBot?: boolean
  eventId?: string
}

export interface FeishuTransport {
  send(input: { chatId: string; text: string; threadId?: string }): Promise<{ messageId: string }>
}

export interface FeishuSource {
  start(onMessage: (message: FeishuMessage) => Promise<void>): Promise<void>
  stop(): Promise<void>
}

export interface FeishuLinkOptions {
  verificationToken?: string
  botOpenId?: string
  source?: FeishuSource
}

function parseText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return parsed.text ?? ''
  } catch {
    return content
  }
}

/**
 * Official Feishu event shape (v2). No SDK: webhook in, REST out.
 * Long-connection mode can reuse normalizeEvent; it only changes transport.
 */
export function verifyChallenge(payload: any, verificationToken?: string): string | undefined {
  if (payload?.type !== 'url_verification') return undefined
  if (verificationToken && payload.token !== verificationToken) return undefined
  return typeof payload.challenge === 'string' ? payload.challenge : undefined
}

/** SDK long-connection handler receives header+event merged. */
export function normalizeMergedEvent(data: any, options: FeishuLinkOptions = {}): FeishuMessage | undefined {
  return normalizeEvent({
    header: { event_id: data?.event_id, event_type: 'im.message.receive_v1', token: data?.token },
    event: { sender: data?.sender, message: data?.message },
  }, options)
}

export function normalizeEvent(payload: any, options: FeishuLinkOptions = {}): FeishuMessage | undefined {
  const header = payload?.header
  const event = payload?.event
  if (!header || !event || header.event_type !== 'im.message.receive_v1') return undefined
  if (options.verificationToken && header.token !== options.verificationToken) return undefined
  if (event.sender?.sender_type && event.sender.sender_type !== 'user') return undefined
  const message = event.message ?? {}
  const openId = event.sender?.sender_id?.open_id
  if (!openId || !message.chat_id || !message.message_id) return undefined
  const mentioned = Array.isArray(message.mentions) && message.mentions.some((m: any) => m?.id?.open_id === options.botOpenId)
  return {
    openId,
    chatId: message.chat_id,
    messageId: message.message_id,
    threadId: message.root_id || message.parent_id || message.message_id,
    text: parseText(message.content ?? ''),
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    mentionedBot: mentioned,
    eventId: header.event_id,
  }
}

export class FeishuLink implements LinkProvider {
  readonly id = 'feishu'
  readonly capabilities: LinkCapabilities = { threads: true, cards: true, media: true, approvals: true }

  private host?: LinkHost
  private readonly transport: FeishuTransport
  private readonly options: FeishuLinkOptions

  constructor(transport: FeishuTransport, options: FeishuLinkOptions = {}) {
    this.transport = transport
    this.options = options
  }

  async start(host: LinkHost): Promise<void> {
    this.host = host
    if (this.options.source) {
      await this.options.source.start(async (message) => { await this.ingestMessage(message) })
    }
  }

  async stop(): Promise<void> {
    if (this.options.source) await this.options.source.stop()
    this.host = undefined
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const result = await this.transport.send({
        chatId: message.conversationId,
        text: message.text,
        threadId: message.threadId,
      })
      return { ok: true, messageId: result.messageId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async receive(payload: any): Promise<IngestResult> {
    const message = normalizeEvent(payload, this.options)
    if (!message) return { accepted: false, reason: 'ignored' }
    return this.ingestMessage(message, payload)
  }

  async receiveMerged(data: any): Promise<IngestResult> {
    const message = normalizeMergedEvent(data, this.options)
    if (!message) return { accepted: false, reason: 'ignored' }
    return this.ingestMessage(message, data)
  }

  private async ingestMessage(message: FeishuMessage, raw?: unknown): Promise<IngestResult> {
    if (!this.host) throw new Error('feishu link is not started')
    const event: InboundEvent = {
      linkId: this.id,
      accountId: 'feishu',
      conversationId: message.chatId,
      threadId: message.threadId,
      messageId: message.messageId,
      dedupeKey: message.messageId,
      conversationType: message.chatType === 'group' ? 'group' : 'dm',
      addressed: message.chatType !== 'group' || message.mentionedBot === true,
      sender: { id: message.openId },
      text: message.text,
      timestamp: new Date().toISOString(),
      raw: raw ?? message,
    }
    return this.host.ingest(event)
  }
}
