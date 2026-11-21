# advisers-bridge-hermes

Expose **Advisers** to the [Hermes Agent messaging gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)
through the Hermes **bridge-adapter** JSON-file contract.

Hermes owns the platform adapters (Telegram, Feishu, WeCom, Slack, Discord,
Email, …), allowlists/pairing, slash commands, threads, approvals and delivery
ledger. Advisers only exchanges JSON files.

`0.4.1` is the current lockstep release (published 2026-11-21; a same-day follow-up patch on 0.4.0); the bridge
JSON-file contract is unchanged from 0.3.2.

```
Hermes gateway  <->  bridge-adapter  <->  inbox/outbox JSON  <->  advisers bridge
```

## Use

1. Install the Hermes `bridge-adapter` plugin and set `BRIDGE_DIR`.
2. Start Advisers:

```sh
advisers bridge --dir "$BRIDGE_DIR" --name advisers
```

3. The bridge writes `registry/advisers.yaml`, `status/advisers/status.json`,
   consumes `inbox/advisers/*.json`, and writes `outbox/advisers/*.json`.

## Contract

Inbox (Hermes -> Advisers): `id`, `sender`, `sender_name`, `text`, `timestamp`,
`chat {id,type,thread_id}`, `attachments`, `reply_to`.
Outbox (Advisers -> Hermes): `id`, `target` (`advisers~<chatId>`), `text`,
`thread_id`, `reply_to`, `attachments`, `metadata.idempotencyKey`.

Dedupe is the bridge `id`; Advisers persists it in SQLite `seen_events` so a
restart does not replay. Delivery is at-least-once by design.

## Why a bridge, not 20 adapters

Hermes already has the per-platform work (auth, reconnect, media, cards,
approval UX, pairing, delivery ledger). Rebuilding that for each platform is
the wrong layer. The bridge is one file contract; Advisers keeps its Link SPI
for standalone email/Feishu.

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
