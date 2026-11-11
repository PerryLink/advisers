export interface FeishuApiConfig {
  appId: string
  appSecret: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/** Minimal tenant-token + text-message API; no SDK, no webhook server. */
export class FeishuApiTransport {
  private readonly config: FeishuApiConfig
  private token?: { value: string; expiresAt: number }

  constructor(config: FeishuApiConfig) {
    this.config = config
  }

  private get base(): string {
    return (this.config.baseUrl ?? 'https://open.feishu.cn').replace(/\/$/, '')
  }

  private get fetchImpl(): typeof fetch {
    return this.config.fetchImpl ?? fetch
  }

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    const response = await this.fetchImpl(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    })
    const data = await response.json() as any
    if (!response.ok || data.code !== 0) throw new Error(`feishu token failed: ${data.code ?? response.status}`)
    this.token = { value: data.tenant_access_token, expiresAt: Date.now() + (data.expire ?? 7200) * 1000 }
    return this.token.value
  }

  async send(input: { chatId: string; text: string; threadId?: string }): Promise<{ messageId: string }> {
    const token = await this.tenantToken()
    const response = await this.fetchImpl(`${this.base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: input.chatId, msg_type: 'text', content: JSON.stringify({ text: input.text }) }),
    })
    const data = await response.json() as any
    if (!response.ok || data.code !== 0) throw new Error(`feishu send failed: ${data.code ?? response.status}`)
    return { messageId: data.data?.message_id ?? '' }
  }
}
