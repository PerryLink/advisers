import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export type SendPurpose = 'reply' | 'draft' | 'crisis_script' | 'forward' | 'test'

export interface SendDraft {
  text: string
  cards?: { title: string; body: string }[]
  attachments?: { kind: string; name?: string; url?: string; localPath?: string; mimeType?: string; size?: number }[]
  replyTo?: string
}

export interface PermitRecipient {
  linkId?: string
  accountId?: string
  conversationId: string
  threadId?: string
}

/** A one-shot permission to perform an outbound side effect. */
export interface SendPermit {
  id: string
  v?: 1
  approvalId?: string
  linkId?: string
  purpose?: SendPurpose
  conversationId: string
  threadId?: string
  accountId?: string
  draftHash?: string
  recipientHash?: string
  issuedAt: number
  expiresAt: number
  signature: string
}

export interface PermitRequest extends PermitRecipient {
  linkId?: string
  purpose?: SendPurpose
  approvalId?: string
  draft?: SendDraft
}

export type PermitDenyReason =
  | 'expired' | 'consumed' | 'wrong-conversation' | 'wrong-account' | 'bad-signature'
  | 'wrong-link' | 'wrong-thread' | 'wrong-purpose' | 'draft-mismatch' | 'recipient-mismatch' | 'malformed'

export interface PermitCheck {
  ok: boolean
  reason?: PermitDenyReason
}

export interface PermitAuthorization {
  ok: boolean
  reason?: PermitDenyReason
  permitId?: string
}

export interface PermitReplayStore {
  has?(permitId: string): boolean
  claim(permitId: string, expiresAt: number): boolean
  prune?(now: number): number
}

export class MemoryPermitReplayStore implements PermitReplayStore {
  private readonly seen = new Map<string, number>()
  has(permitId: string): boolean { return this.seen.has(permitId) }
  claim(permitId: string, expiresAt: number): boolean {
    if (this.seen.has(permitId)) return false
    this.seen.set(permitId, expiresAt)
    return true
  }
  prune(now: number): number {
    let n = 0
    for (const [id, exp] of this.seen) if (exp <= now) { this.seen.delete(id); n++ }
    return n
  }
}

function canonicalDraft(draft: SendDraft): string {
  return JSON.stringify({
    text: draft.text,
    cards: draft.cards ?? [],
    attachments: (draft.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name ?? null, url: a.url ?? null, localPath: a.localPath ?? null, mimeType: a.mimeType ?? null, size: a.size ?? null })),
    replyTo: draft.replyTo ?? null,
  })
}

export function draftDigest(draft: SendDraft): string {
  return createHash('sha256').update(canonicalDraft(draft)).digest('hex')
}

export function recipientDigest(r: PermitRecipient): string {
  return createHash('sha256').update([r.linkId ?? '', r.accountId ?? '', r.conversationId, r.threadId ?? ''].join('\n')).digest('hex')
}

function payload(permit: SendPermit): string {
  return [
    'advisers.permit.v1',
    permit.id,
    permit.approvalId ?? '',
    permit.linkId ?? '',
    permit.purpose ?? '',
    permit.conversationId,
    permit.threadId ?? '',
    permit.accountId ?? '',
    permit.draftHash ?? '',
    permit.recipientHash ?? '',
    permit.issuedAt,
    permit.expiresAt,
  ].join('\n')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export interface PermitGateOptions {
  now?: () => number
  replay?: PermitReplayStore
  maxTtlMs?: number
}

/** Core-issued, link-verified, one-shot. v1 uses HMAC-SHA256. */
export class PermitGate {
  private readonly secret: string
  private readonly now: () => number
  private readonly replay: PermitReplayStore
  private readonly maxTtlMs: number

  constructor(secret: string, nowOrOptions: (() => number) | PermitGateOptions = {}) {
    if (!secret) throw new Error('permit secret is required')
    const options = typeof nowOrOptions === 'function' ? { now: nowOrOptions } : nowOrOptions
    this.secret = secret
    this.now = options.now ?? (() => Date.now())
    this.replay = options.replay ?? new MemoryPermitReplayStore()
    this.maxTtlMs = options.maxTtlMs ?? 15 * 60_000
  }

  issue(request: PermitRequest, ttlMs = 5 * 60_000): SendPermit {
    const issuedAt = this.now()
    const ttl = Math.min(Math.max(1, ttlMs), this.maxTtlMs)
    const base: SendPermit = {
      id: `permit_${randomUUID()}`,
      v: 1,
      approvalId: request.approvalId,
      linkId: request.linkId,
      purpose: request.purpose,
      conversationId: request.conversationId,
      threadId: request.threadId,
      accountId: request.accountId,
      draftHash: request.draft ? draftDigest(request.draft) : undefined,
      recipientHash: recipientDigest(request),
      issuedAt,
      expiresAt: issuedAt + ttl,
      signature: '',
    }
    base.signature = createHmac('sha256', this.secret).update(payload(base)).digest('hex')
    return base
  }

  verify(permit: SendPermit, request: PermitRequest): PermitCheck {
    if (!permit || permit.v !== 1 || !permit.id) return { ok: false, reason: 'malformed' }
    if (permit.expiresAt <= this.now()) return { ok: false, reason: 'expired' }
    const expected = createHmac('sha256', this.secret).update(payload({ ...permit, signature: '' })).digest('hex')
    if (!safeEqual(expected, permit.signature)) return { ok: false, reason: 'bad-signature' }
    if (this.replay.has?.(permit.id)) return { ok: false, reason: 'consumed' }
    if (permit.conversationId !== request.conversationId) return { ok: false, reason: 'wrong-conversation' }
    if (permit.linkId && permit.linkId !== request.linkId) return { ok: false, reason: 'wrong-link' }
    if (permit.accountId && permit.accountId !== request.accountId) return { ok: false, reason: 'wrong-account' }
    if ((permit.threadId ?? '') !== (request.threadId ?? '')) return { ok: false, reason: 'wrong-thread' }
    if (permit.purpose && permit.purpose !== request.purpose) return { ok: false, reason: 'wrong-purpose' }
    if (permit.draftHash) {
      if (!request.draft) return { ok: false, reason: 'draft-mismatch' }
      if (!safeEqual(permit.draftHash, draftDigest(request.draft))) return { ok: false, reason: 'draft-mismatch' }
    }
    if (permit.recipientHash && !safeEqual(permit.recipientHash, recipientDigest(request))) return { ok: false, reason: 'recipient-mismatch' }
    return { ok: true }
  }

  consume(permit: SendPermit): boolean {
    return this.replay.claim(permit.id, permit.expiresAt)
  }

  /** Verify and consume in one call; safe for the send path. */
  authorize(permit: SendPermit, request: PermitRequest): PermitAuthorization {
    const check = this.verify(permit, request)
    if (!check.ok) return { ok: false, reason: check.reason }
    if (!this.consume(permit)) return { ok: false, reason: 'consumed' }
    return { ok: true, permitId: permit.id }
  }
}
