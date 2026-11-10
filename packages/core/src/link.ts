import type { Id } from './types.ts'

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video'

export interface Attachment {
  kind: AttachmentKind
  name?: string
  url?: string
  localPath?: string
  mimeType?: string
  size?: number
}

export interface LinkCapabilities {
  threads: boolean
  cards: boolean
  media: boolean
  approvals: boolean
}

export interface LinkSender {
  id: string
  name?: string
}

export interface InboundEvent {
  linkId: string
  accountId: string
  conversationId: string
  threadId?: string
  messageId: string
  sender: LinkSender
  text?: string
  attachments?: Attachment[]
  quote?: string
  timestamp: string
  raw?: unknown
}

export interface LinkHost {
  /** Normalize one inbound event into the runtime. Must be idempotent by messageId. */
  ingest(event: InboundEvent): Promise<void>
  /** Map a platform account to the runtime principal. */
  resolvePrincipal(account: { linkId: string; accountId: string }): Promise<Id>
}

export interface DeliveryResult {
  ok: boolean
  messageId?: string
  error?: string
}

export interface OutboundMessage {
  conversationId: string
  threadId?: string
  text: string
  cards?: Array<{ title: string; body: string }>
  attachments?: Attachment[]
  replyTo?: string
}

/**
 * The only integration surface between the core and a transport.
 * Implementations must not be imported by the core.
 */
export interface LinkProvider {
  id: string
  capabilities: LinkCapabilities
  start(host: LinkHost): Promise<void>
  send(message: OutboundMessage): Promise<DeliveryResult>
  stop(): Promise<void>
}
