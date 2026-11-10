import { assembleContext } from './context.ts'
import { Ledger } from './ledger.ts'
import type { HostPorts } from './ports.ts'
import type { InboundEvent, LinkHost, LinkProvider, OutboundMessage, DeliveryResult } from './link.ts'
import type { TurnContext } from './types.ts'

export interface AdvisersOptions {
  budget?: number
  ports?: HostPorts
}

/**
 * Headless runtime. The CLI, the DSH bundle, and every link are adapters.
 * Today the ledger and the reply are in-memory stubs; the interfaces are the point.
 */
export class AdvisersRuntime implements LinkHost {
  readonly ledger: Ledger
  private readonly links = new Map<string, LinkProvider>()
  private readonly conversationMatter = new Map<string, string>()
  private readonly seen = new Set<string>()
  private readonly budget: number

  constructor(options: AdvisersOptions = {}) {
    this.budget = options.budget ?? 1200
    this.ledger = new Ledger(options.ports)
  }

  registerLink(link: LinkProvider): void {
    if (this.links.has(link.id)) throw new Error(`link already registered: ${link.id}`)
    this.links.set(link.id, link)
  }

  async startLinks(): Promise<void> {
    for (const link of this.links.values()) await link.start(this)
  }

  async stopLinks(): Promise<void> {
    for (const link of this.links.values()) await link.stop()
  }

  async resolvePrincipal(account: { linkId: string; accountId: string }): Promise<string> {
    return `${account.linkId}:${account.accountId}`
  }

  /**
   * LinkHost.ingest: normalize one inbound event.
   * The real runtime will feed the returned context to the host's LLM.
   */
  async ingest(event: InboundEvent): Promise<void> {
    const key = `${event.linkId}:${event.dedupeKey ?? event.messageId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    // A group message that is not addressed to the adviser is observed by the
    // link but is not a user instruction.
    if (event.conversationType === 'group' && event.addressed === false) return
    this.handleInbound(event)
  }

  handleInbound(event: InboundEvent): TurnContext {
    const key = `${event.linkId}:${event.conversationId}`
    let matterId = this.conversationMatter.get(key)
    if (!matterId) {
      const matter = this.ledger.addMatter({
        title: event.text?.slice(0, 60) || `conversation ${event.conversationId}`,
        summary: event.text?.slice(0, 200),
      })
      matterId = matter.id
      this.conversationMatter.set(key, matterId)
    }
    const matter = this.ledger.getMatter(matterId)
    if (!matter) throw new Error(`matter disappeared: ${matterId}`)

    if (event.text) {
      this.ledger.remember({
        subject: 'user',
        predicate: 'said',
        object: event.text,
        matterId,
        source: { quote: event.text, ref: event.messageId },
      })
    }

    return assembleContext({ matter, ledger: this.ledger, budget: this.budget })
  }

  async send(linkId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const link = this.links.get(linkId)
    if (!link) return { ok: false, error: `unknown link: ${linkId}` }
    return link.send(message)
  }
}

export function createAdvisers(options: AdvisersOptions = {}): AdvisersRuntime {
  return new AdvisersRuntime(options)
}
