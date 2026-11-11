# advisers-link-feishu

Feishu/Lark Link for Advisers. Official webhook events + REST message API, no
SDK dependency.

- `normalizeEvent` maps `im.message.receive_v1` to an `InboundEvent`; group
  messages are addressed only when the bot is mentioned.
- `dedupeKey` is `message_id` (retries keep the same key).
- `verifyChallenge` answers the URL-verification challenge.
- `FeishuApiTransport` caches a tenant token and sends text messages.

Not implemented yet: WebSocket long connection, interactive cards/approval,
encrypted events, history backfill. Those are the next slice.

```ts
import { FeishuLink, FeishuApiTransport } from 'advisers-link-feishu'

const link = new FeishuLink(new FeishuApiTransport({ appId, appSecret }), {
  verificationToken,
  botOpenId,
})
```
