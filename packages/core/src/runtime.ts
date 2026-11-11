import { assembleContext } from './context.ts'
import { buildIntentBrief } from './intent.ts'
import type { IntentBrief } from './intent.ts'
import { DEFAULT_AFFECT_POLICY } from './policy.ts'
import type { AffectPolicy } from './policy.ts'
import { Ledger } from './ledger.ts'
import type { HostPorts } from './ports.ts'
import { systemPorts } from './ports.ts'
import type { InboundEvent, IngestResult, LinkHost, LinkProvider, OutboundMessage, DeliveryResult } from './link.ts'
import type { Episode, Thread, TurnContext } from './types.ts'

export interface AdvisersOptions {
  budget?: number
  ports?: HostPorts
  ledger?: Ledger
  /** 0..3; the local owner normally has 3. */
  clearance?: number
  stage?: 'probation' | 'trusted'
  policy?: AffectPolicy
}

/**
 * Headless runtime. The CLI, the DSH bundle, and every link are adapters.
 * Today the ledger and the reply are in-memory stubs; the interfaces are the point.
 */
export class AdvisersRuntime implements LinkHost {
  readonly ledger: Ledger
  private readonly links = new Map<string, LinkProvider>()
  private readonly threads = new Map<string, Thread>()
  private readonly episodes = new Map<string, Episode>()
  private readonly seen = new Set<string>()
  private readonly budget: number
  private readonly clearance: number
  private readonly stage: 'probation' | 'trusted'
  readonly policy: AffectPolicy
  private readonly ports?: HostPorts
  private readonly clock: HostPorts['clock']
  private readonly ids: HostPorts['ids']

  constructor(options: AdvisersOptions = {}) {
    const ports = options.ports ?? systemPorts()
    this.budget = options.budget ?? 1200
    this.clearance = options.clearance ?? 3
    this.stage = options.stage ?? 'probation'
    this.policy = options.policy ?? DEFAULT_AFFECT_POLICY
    this.ports = options.ports
    this.clock = ports.clock
    this.ids = ports.ids
    this.ledger = options.ledger ?? new Ledger(ports)
  }

  /** Build the intent brief without recording a turn. */
  brief(text: string): IntentBrief {
    return buildIntentBrief(text, { stage: this.stage })
  }

  /** Soul is human-owned; the runtime only reads it. */
  readSoul() {
    return this.ports?.soul?.load()
  }

  ensureThread(principalId: string): Thread {
    const existing = this.threads.get(principalId)
    if (existing) return existing
    const now = this.clock.now()
    // Deterministic so a CLI restart does not create a new relationship id.
    let hash = 0
    for (let i = 0; i < principalId.length; i++) hash = (hash * 31 + principalId.charCodeAt(i)) | 0
    const thread: Thread = {
      id: `thread_${Math.abs(hash).toString(36)}`,
      principalId,
      createdAt: now,
      updatedAt: now,
    }
    this.threads.set(principalId, thread)
    return thread
  }

  listThreads(): Thread[] {
    return [...this.threads.values()]
  }

  listEpisodes(threadId?: string): Episode[] {
    return [...this.episodes.values()].filter((e) => (threadId ? e.threadId === threadId : true))
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
  async ingest(event: InboundEvent): Promise<IngestResult> {
    const key = `${event.linkId}:${event.dedupeKey ?? event.messageId}`
    if (this.seen.has(key)) return { accepted: false, reason: 'duplicate' }
    this.seen.add(key)
    // A group message that is not addressed to the adviser is observed by the
    // link but is not a user instruction.
    if (event.conversationType === 'group' && event.addressed === false) {
      return { accepted: false, reason: 'ignored' }
    }
    this.handleInbound(event)
    return { accepted: true }
  }

  handleInbound(event: InboundEvent): TurnContext {
    const principalId = `${event.linkId}:${event.accountId}`
    const thread = this.ensureThread(principalId)
    const key = `${thread.id}:${event.conversationId}`
    let matterId = this.ledger.getRoute(key)
    if (!matterId) {
      const matter = this.ledger.addMatter({
        title: event.text?.slice(0, 60) || `conversation ${event.conversationId}`,
        summary: event.text?.slice(0, 200),
      })
      matterId = matter.id
      this.ledger.setRoute(key, matterId)
    }
    const matter = this.ledger.getMatter(matterId)
    if (!matter) throw new Error(`matter disappeared: ${matterId}`)

    const intent = buildIntentBrief(event.text ?? '', { stage: this.stage })
    const related = this.ledger.listLinks(matter.id, false).flatMap((link) => {
      const otherId = link.fromMatter === matter.id ? link.toMatter : link.fromMatter
      const other = this.ledger.getMatter(otherId)
      return other ? [{ matterId: other.id, title: other.title, why: `${link.type} link` }] : []
    })
    const context = assembleContext({
      matter,
      ledger: this.ledger,
      budget: this.budget,
      clearance: this.clearance,
      soul: this.readSoul(),
      intent,
      related,
    })

    if (event.text) {
      this.ledger.remember({
        subject: 'user',
        predicate: 'said',
        object: event.text,
        matterId,
        source: { quote: event.text, ref: event.messageId },
      })
      matter.summary = event.text.slice(0, 200)
      matter.updatedAt = this.clock.now()
      thread.updatedAt = matter.updatedAt
    }

    const episode: Episode = {
      id: this.ids.next('ep'),
      threadId: thread.id,
      matterId,
      startedAt: event.timestamp,
      summary: event.text?.slice(0, 120),
    }
    this.episodes.set(episode.id, episode)

    return { ...context, threadId: thread.id, intent }
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
