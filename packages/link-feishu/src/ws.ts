import * as Lark from '@larksuiteoapi/node-sdk'
import { normalizeMergedEvent } from './index.ts'
import type { FeishuLinkOptions, FeishuMessage, FeishuSource } from './index.ts'

export interface FeishuWsConfig {
  appId: string
  appSecret: string
  domain?: 'feishu' | 'lark'
  autoReconnect?: boolean
}

/**
 * Official long-connection source: no public IP, no webhook signature.
 * The handler must normalize + enqueue within 3s; do not call the model here.
 */
export class FeishuWsSource implements FeishuSource {
  private readonly config: FeishuWsConfig
  private readonly options: FeishuLinkOptions
  private ws?: Lark.WSClient

  constructor(config: FeishuWsConfig, options: FeishuLinkOptions = {}) {
    this.config = config
    this.options = options
  }

  async start(onMessage: (message: FeishuMessage) => Promise<void>): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const message = normalizeMergedEvent(data, this.options)
        if (message) await onMessage(message)
      },
    })
    this.ws = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      autoReconnect: this.config.autoReconnect ?? true,
    })
    await this.ws.start({ eventDispatcher: dispatcher })
  }

  async stop(): Promise<void> {
    this.ws?.close({ force: true })
    this.ws = undefined
  }

  status(): string {
    return String(this.ws?.getConnectionStatus() ?? 'idle')
  }
}
