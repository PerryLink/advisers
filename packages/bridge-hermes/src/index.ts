import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DeliveryResult,
  InboundEvent,
  LinkCapabilities,
  LinkHost,
  LinkProvider,
  OutboundMessage,
} from 'advisers-core'

export interface HermesBridgeConfig {
  /** The BRIDGE_DIR used by the Hermes bridge-adapter plugin. */
  bridgeDir: string
  /** Bridge name; also the registry file name. */
  name?: string
  pollMs?: number
  /** Optional target formats advertised in the manifest. */
  targetFormat?: string[]
  capabilities?: string[]
}

export interface HermesInboxMessage {
  bridge?: string
  id?: string
  sender?: string
  sender_name?: string
  text?: string
  timestamp?: string
  chat?: { id?: string; type?: 'dm' | 'group' | 'channel'; name?: string; thread_id?: string }
  attachments?: Array<{ type?: string; url?: string; mime?: string; size?: number; name?: string }>
  reply_to?: string
}

/**
 * Exposes Advisers as a Hermes bridge-adapter bridge.
 *
 * Hermes owns the 20+ platform adapters, allowlist/pairing, commands, threads,
 * approvals and delivery ledger. This process only exchanges JSON files:
 * inbox/<name>/*.json -> runtime; outbox/<name>/*.json <- runtime.
 */
export class HermesBridgeLink implements LinkProvider {
  readonly id = 'hermes-bridge'
  readonly capabilities: LinkCapabilities = {
    threads: true,
    cards: false,
    media: true,
    approvals: false,
    mentions: true,
    proactiveWindow: 'bridge',
  }

  private host?: LinkHost
  private timer?: NodeJS.Timeout
  private heartbeat?: NodeJS.Timeout
  private readonly cfg: Required<Omit<HermesBridgeConfig, 'targetFormat' | 'capabilities'>> & {
    targetFormat: string[]
    capabilities: string[]
  }
  private readonly processing = new Set<string>()
  private connected = false
  private lastEventAt = 0

  constructor(config: HermesBridgeConfig) {
    this.cfg = {
      bridgeDir: config.bridgeDir,
      name: config.name ?? 'advisers',
      pollMs: config.pollMs ?? 1000,
      targetFormat: config.targetFormat ?? ['chat_id'],
      capabilities: config.capabilities ?? ['text', 'file', 'image'],
    }
  }

  private dir(kind: 'registry' | 'inbox' | 'outbox' | 'status'): string {
    return kind === 'registry'
      ? join(this.cfg.bridgeDir, 'registry')
      : kind === 'inbox'
        ? join(this.cfg.bridgeDir, 'inbox', this.cfg.name)
        : kind === 'outbox'
          ? join(this.cfg.bridgeDir, 'outbox', this.cfg.name)
          : join(this.cfg.bridgeDir, 'status', this.cfg.name)
  }

  async start(host: LinkHost): Promise<void> {
    this.host = host
    await Promise.all([this.dir('registry'), this.dir('inbox'), this.dir('outbox'), this.dir('status')].map((d) => mkdir(d, { recursive: true })))
    const manifest = [
      `name: ${this.cfg.name}`,
      'service: advisers',
      'host: local',
      `target_format: [${this.cfg.targetFormat.join(', ')}]`,
      `capabilities: [${this.cfg.capabilities.join(', ')}]`,
      '',
    ].join('\n')
    await writeFile(join(this.dir('registry'), `${this.cfg.name}.yaml`), manifest)
    await this.writeStatus(true)
    this.connected = true
    await this.pollOnce()
    this.timer = setInterval(() => { void this.pollOnce().catch(() => undefined) }, this.cfg.pollMs)
    this.timer.unref?.()
    this.heartbeat = setInterval(() => { void this.writeStatus(true).catch(() => undefined) }, 30_000)
    this.heartbeat.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.connected = false
    await this.writeStatus(false).catch(() => undefined)
    await unlink(join(this.dir('registry'), `${this.cfg.name}.yaml`)).catch(() => undefined)
    this.host = undefined
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: this.connected, detail: this.connected ? `${this.cfg.name} bridge connected` : 'bridge stopped' }
  }

  /** Public for deterministic tests; the poll loop calls the same function. */
  async pollOnce(): Promise<void> {
    if (!this.host) return
    let files: string[]
    try {
      files = (await readdir(this.dir('inbox'))).filter((f) => f.endsWith('.json')).sort()
    } catch {
      return
    }
    for (const file of files) {
      if (this.processing.has(file)) continue
      this.processing.add(file)
      try {
        const raw = JSON.parse(await readFile(join(this.dir('inbox'), file), 'utf8')) as HermesInboxMessage
        if (raw.bridge && raw.bridge !== this.cfg.name) continue
        const event = this.toEvent(raw)
        const result = await this.host.ingest(event)
        if (result.accepted || result.reason === 'duplicate' || result.reason === 'ignored') {
          await unlink(join(this.dir('inbox'), file)).catch(() => undefined)
          this.lastEventAt = Date.now()
          await this.writeStatus(true)
        }
      } catch {
        // Leave the file for a retry; Hermes bridge adapter quarantines after N failures.
      } finally {
        this.processing.delete(file)
      }
    }
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    try {
      const id = `out_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      const outbound = {
        bridge: this.cfg.name,
        id,
        target: `${this.cfg.name}~${message.conversationId}`,
        text: message.text,
        attachments: (message.attachments ?? []).map((a) => ({
          type: a.kind,
          url: a.localPath ?? a.url,
          mime: a.mimeType,
          size: a.size,
          name: a.name,
        })),
        reply_to: message.replyTo,
        thread_id: message.threadId,
        metadata: { idempotencyKey: message.idempotencyKey },
      }
      await mkdir(this.dir('outbox'), { recursive: true })
      const target = join(this.dir('outbox'), `${id}.json`)
      const tmp = `${target}.tmp`
      await writeFile(tmp, JSON.stringify(outbound, null, 2))
      await rename(tmp, target)
      return { ok: true, messageId: id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private toEvent(raw: HermesInboxMessage): InboundEvent {
    const chat = raw.chat ?? {}
    const conversationId = String(chat.id ?? raw.sender ?? 'unknown')
    const id = String(raw.id ?? `inbox_${randomUUID()}`)
    const chatType = chat.type === 'group' || chat.type === 'channel' ? chat.type : 'dm'
    return {
      linkId: this.id,
      accountId: this.cfg.name,
      conversationId,
      threadId: chat.thread_id,
      messageId: id,
      dedupeKey: id,
      conversationType: chatType,
      addressed: true,
      sender: { id: String(raw.sender ?? 'unknown'), name: raw.sender_name },
      text: raw.text ?? '',
      attachments: (raw.attachments ?? []).map((a) => ({
        kind: a.type === 'image' ? 'image' : a.type === 'voice' ? 'audio' : a.type === 'video' ? 'video' : 'file',
        name: a.name,
        url: a.url,
        mimeType: a.mime,
        size: a.size,
      })),
      timestamp: raw.timestamp ?? new Date().toISOString(),
      raw,
    }
  }

  private async writeStatus(connected: boolean): Promise<void> {
    const status = {
      connected,
      last_seen: new Date().toISOString(),
      last_event_at: this.lastEventAt || undefined,
      error: null,
      version: '0.2.0-preview.16',
    }
    await mkdir(this.dir('status'), { recursive: true })
    const target = join(this.dir('status'), 'status.json')
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(status, null, 2))
    await rename(tmp, target)
  }
}
