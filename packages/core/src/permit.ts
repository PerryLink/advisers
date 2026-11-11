import { createHmac, randomUUID } from 'node:crypto'

/** A one-shot permission to perform an outbound side effect. */
export interface SendPermit {
  id: string
  approvalId?: string
  conversationId: string
  threadId?: string
  accountId?: string
  issuedAt: number
  expiresAt: number
  signature: string
}

export interface PermitRequest {
  conversationId: string
  threadId?: string
  accountId?: string
  approvalId?: string
}

export interface PermitCheck {
  ok: boolean
  reason?: 'expired' | 'consumed' | 'wrong-conversation' | 'wrong-account' | 'bad-signature'
}

function payload(permit: Omit<SendPermit, 'signature'>): string {
  return [
    permit.id,
    permit.approvalId ?? '',
    permit.conversationId,
    permit.threadId ?? '',
    permit.accountId ?? '',
    permit.issuedAt,
    permit.expiresAt,
  ].join('\n')
}

/**
 * Core-issued, link-verified, one-shot. v1 uses HMAC-SHA256; a future version
 * can swap the signer without changing the link contract.
 */
export class PermitGate {
  private readonly secret: string
  private readonly now: () => number
  private readonly consumed = new Set<string>()

  constructor(secret: string, now: () => number = () => Date.now()) {
    if (!secret) throw new Error('permit secret is required')
    this.secret = secret
    this.now = now
  }

  issue(request: PermitRequest, ttlMs = 5 * 60_000): SendPermit {
    const issuedAt = this.now()
    const base = {
      id: `permit_${randomUUID()}`,
      approvalId: request.approvalId,
      conversationId: request.conversationId,
      threadId: request.threadId,
      accountId: request.accountId,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    }
    return { ...base, signature: createHmac('sha256', this.secret).update(payload(base)).digest('hex') }
  }

  verify(permit: SendPermit, request: PermitRequest): PermitCheck {
    if (permit.expiresAt <= this.now()) return { ok: false, reason: 'expired' }
    if (permit.conversationId !== request.conversationId) return { ok: false, reason: 'wrong-conversation' }
    if (permit.accountId && request.accountId && permit.accountId !== request.accountId) {
      return { ok: false, reason: 'wrong-account' }
    }
    if (this.consumed.has(permit.id)) return { ok: false, reason: 'consumed' }
    const expected = createHmac('sha256', this.secret)
      .update(payload({ ...permit, signature: undefined } as unknown as Omit<SendPermit, 'signature'>))
      .digest('hex')
    if (expected !== permit.signature) return { ok: false, reason: 'bad-signature' }
    return { ok: true }
  }

  consume(permit: SendPermit): boolean {
    if (this.consumed.has(permit.id)) return false
    this.consumed.add(permit.id)
    return true
  }
}
