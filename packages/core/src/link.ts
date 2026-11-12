import type { Id } from './types.ts'
import type { SendPermit } from './permit.ts'
import type { PermitGate } from './permit.ts'

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
  /** Optional, for rendering and for choosing a fallback. */
  maxTextLength?: number
  maxAttachments?: number
  mentions?: boolean
  proactiveWindow?: string
  approvalMode?: 'none' | 'text' | 'card'
}

export interface LinkSender {
  id: string
  name?: string
}

export type ConversationType = 'dm' | 'group' | 'channel' | 'email'

export interface QuoteRef {
  messageId: string
  text?: string
  authorId?: string
}

export interface InboundEvent {
  linkId: string
  accountId: string
  conversationId: string
  threadId?: string
  messageId: string
  /** Defaults to messageId when omitted. Used for idempotent ingest. */
  dedupeKey?: string
  conversationType?: ConversationType
  /** In a group, whether this message is addressed to the adviser. */
  addressed?: boolean
  mentions?: string[]
  /** A verified owner/CLI channel; absent means external/untrusted. */
  trusted?: boolean
  sender: LinkSender
  text?: string
  attachments?: Attachment[]
  quote?: string | QuoteRef
  timestamp: string
  raw?: unknown
}

export type IngestReason = 'duplicate' | 'stale' | 'unauthorized' | 'ignored'

export interface IngestResult {
  accepted: boolean
  reason?: IngestReason
}

export interface LinkHost {
  /** Normalize one inbound event into the runtime. Must be idempotent by dedupeKey. */
  ingest(event: InboundEvent): Promise<IngestResult>
  /** Map a platform account to the runtime principal. */
  resolvePrincipal(account: { linkId: string; accountId: string }): Promise<Id>
}

export interface DeliveryResult {
  ok: boolean
  messageId?: string
  error?: string
  /** The transport cannot prove whether the message was delivered. */
  uncertain?: boolean
  /** A core gate rejected the send before it reached the transport. */
  denied?: boolean
}

export interface OutboundMessage {
  conversationId: string
  threadId?: string
  /** Which linked account sends this message; avoids cross-account leaks. */
  accountId?: string
  /** Stable key so a retry does not double-send. */
  idempotencyKey?: string
  text: string
  cards?: Array<{ title: string; body: string }>
  attachments?: Attachment[]
  replyTo?: string
  /** Required when the link has a PermitGate configured. */
  permit?: SendPermit
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
  health?(): Promise<{ ok: boolean; detail?: string }>
}


/** Enforces a one-shot permit at the single egress boundary. */
export class GatedLink implements LinkProvider {
  private readonly inner: LinkProvider
  private readonly gate: PermitGate
  private readonly accountId: string

  constructor(inner: LinkProvider, gate: PermitGate, accountId: string) {
    this.inner = inner
    this.gate = gate
    this.accountId = accountId
  }

  get id(): string { return this.inner.id }
  get capabilities(): LinkCapabilities { return this.inner.capabilities }

  start(host: LinkHost): Promise<void> { return this.inner.start(host) }
  stop(): Promise<void> { return this.inner.stop() }
  health(): Promise<{ ok: boolean; detail?: string }> { return this.inner.health?.() ?? Promise.resolve({ ok: true }) }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    if (!message.permit) return { ok: false, denied: true, error: 'missing send permit' }
    const draft = { text: message.text, cards: message.cards, attachments: message.attachments, replyTo: message.replyTo }
    const request = { linkId: this.inner.id, accountId: this.accountId, conversationId: message.conversationId, threadId: message.threadId, purpose: 'reply' as const, draft }
    const auth = this.gate.authorize(message.permit, request)
    if (!auth.ok) return { ok: false, denied: true, error: `send permit rejected: ${auth.reason ?? 'invalid'}` }
    return this.inner.send(message)
  }
}
