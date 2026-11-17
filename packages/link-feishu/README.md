# advisers-link-feishu

Feishu/Lark Link for Advisers. Official webhook events + REST message API, no
SDK dependency.

- `normalizeEvent` maps `im.message.receive_v1` to an `InboundEvent`; group
  messages are addressed only when the bot is mentioned.
- `dedupeKey` is `message_id` (retries keep the same key).
- `verifyChallenge` answers the URL-verification challenge.
- `FeishuApiTransport` caches a tenant token and sends text messages.

`FeishuWsSource` uses the official SDK (`@larksuiteoapi/node-sdk@1.76`)
`WSClient` + `EventDispatcher` for long-connection mode; the webhook path stays
for deployments without outbound WS. Not implemented yet: interactive
cards/approval, encrypted events, history backfill.

```ts
import { FeishuLink, FeishuApiTransport } from 'advisers-link-feishu'

const link = new FeishuLink(new FeishuApiTransport({ appId, appSecret }), {
  verificationToken,
  botOpenId,
})
```

## License

Software: [PolyForm Noncommercial License 1.0.0](LICENSE) (SPDX
`PolyForm-Noncommercial-1.0.0`); see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Source-available, not open source and not an OSI-approved open source license;
commercial use requires a separate commercial license (open an issue at
<https://github.com/PerryLink/advisers/issues>).

Documentation, evaluation data and design materials of the repository are licensed under
[CC BY-NC-SA 4.0](https://github.com/PerryLink/advisers/blob/main/LICENSE-DOCS); this
package README ships with the software and is covered by PolyForm NC. Third-party
components keep their own licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Versions published before 0.2.0 keep their original licenses (MIT; Apache-2.0 for
`advisers@0.2.0-preview.71`); the change is not retroactive. See the repository
LICENSING.md, LICENSE-DOCS and NOTICE.
