# Read-only mail follow-up (waiting replies)

Status: **0.5.1, schema v23.** `mail followup` is a local, header-only state
engine on top of the existing read-only IMAP mail store. It records "I am waiting
for this person to reply", ties that waiting state to an ordinary commitment, and
moves it when a reply is *proved* by stored thread headers. It **never sends
mail, never drafts, opens no connection, fetches no body and adds no egress
path**; it is not exposed over MCP, DSH, receipt/context packs or the Pet Brief.

```sh
# Pending replies for my explicit email account (needs a prior `mail sync`)
advisers mail followup ls --json

# Turn one received message into a follow-up (3-day default due)
advisers mail followup add --mail <row-id|message-id> --action "ask for the signed quote" --json

# Recompute state from the local ledger only (no network; --dry-run is zero-write)
advisers mail followup check --dry-run --json

# Human override, both recorded with an audit row
advisers mail followup mark-replied <wr_id> --note "answered by phone"
advisers mail followup dismiss <wr_id> --reason replied-elsewhere
```

## 1. Scope and non-goals

- **Read-only.** The only network path in this area remains an explicit
  `mail sync` (TLS-only, read-only IMAP). `mail followup` reads rows the sync
  already stored; `check` never contacts the mail server.
- **Header evidence only.** A follow-up is created from one stored message and
  detects replies from `In-Reply-To` / `References` / `thread_root`, never from
  body sentiment or an LLM guess.
- **It under-reports instead of over-claiming.** Automatic replies, foreign
  senders and fuzzy subject matches never flip the state; they are recorded as
  ignored/warnings/`possibleReplies[]` for human review.
- **Not a send path and not an auto-chaser.** There is no draft, no SMTP/IMAP
  write, no inbox IDLE and no daemon. Reminders are ordinary commitments
  (`dueAt` + `reminderOffsets`) that `remind`/`today`/`who`/`morning` already
  read.
- **Not in MCP/DSH/receipts.** `waiting_replies` and the mail thread headers are
  local user data for the CLI only; the MCP/DSH tool and resource counts are
  unchanged (8 tools / 5 resources, DSH 6 tools).

## 2. Data (schema v23)

Schema v23 adds the mail thread metadata and the waiting state in one migration
step (see [ARCHITECTURE.md](ARCHITECTURE.md) and the migration tests):

| Store | Meaning |
|---|---|
| `mail_messages.in_reply_to` | normalised `<message-id>` of the direct parent, if the header exists |
| `mail_messages.references` | JSON array of `<message-id>` ids (bounded; truncated with a parse warning) |
| `mail_messages.thread_root` | `references[0] ?? in_reply_to ?? message_id` at sync time |
| `mail_messages.direction` | `inbound` / `outbound` / `unknown` (account address or Sent mailbox match) |
| `mail_messages.auto_submitted` | raw `Auto-Submitted` header when present |
| `waiting_replies` | one row per follow-up: `wr_…` id, `commitment_id`, anchor row/message/thread, counterparty, state, basis JSON, timestamps |

The migration does **not** back-fill history: messages synced before the upgrade
have no stored headers, so their `thread_root` stays `NULL` and a follow-up
anchored on them is reported `unknown` / `no-threading-headers` rather than
guessed. Replies that arrive after the upgrade are detectable normally. There is
no `--full` re-fetch in 0.5.1.

`waiting_replies` is part of the user data plane: it is included in
`export`/`backup`/`import` and the sync table list, and it is not in the
"derived"/"local-only" exception (unlike mail cursors, which never travel).

## 3. Commands

| Command | Writes? | Meaning |
|---|---|---|
| `mail followup add (--mail <row-id^\|message-id> \| --thread <message-id>) [--action <text>] [--counterparty <addr>] [--due <expr\|ISO>] [--remind-offsets …] [--matter <id>] [--json]` | one commitment + one `waiting_replies` row + one `followup.add` audit row (single transaction) | create a follow-up from an anchor message |
| `mail followup ls [--state waiting\|replied\|unknown\|dismissed\|all] [--all] [--stale 7d] [--limit 1..500] [--offset N] [--json]` | no | list follow-ups (default: waiting; order waiting -> unknown -> replied -> dismissed, then newest first); `--stale N` keeps waiting anchors at least N days old |
| `mail followup show <wr_id> [--json]` | no | one follow-up plus coverage |
| `mail followup check [--dry-run] [--json]` | `--dry-run` writes nothing; a real run writes only state changes plus one `followup.check` audit row | re-evaluate `waiting`/`unknown` from local headers |
| `mail followup dismiss <wr_id> --reason replied-elsewhere\|no-follow-up\|wrong-thread\|other [--note] [--json]` | state + `followup.dismiss` audit row | stop waiting (terminal state) |
| `mail followup mark-replied <wr_id> [--note] [--json]` | state + `followup.mark-replied` audit row; `basis.method: "manual"` | human proof of a reply (terminal state) |

Creating a follow-up does not change the anchor mail row: it creates a normal
commitment (`debtor: third`, `capability: none`, counterparty as creditor) with
the verbatim subject as evidence (`source.type: mail`), so existing reminder and
brief views work unchanged. `--action` defaults to `等待回复：<subject>`;
`--remind-offsets` is passed through to that commitment. Default due is the anchor
message time **+ 3 days at 18:00 Asia/Shanghai**; `--due` accepts the same Chinese
relative date expressions as `commit`/`receivable` (`E_DUE_UNRESOLVED`/
`E_DUE_CONFLICT` on bad input).

The same anchor message + counterparty cannot be created twice while a
`waiting`/`unknown` row exists: that is `E_FOLLOWUP_EXISTS` with a hint to run
`mail followup ls`.

## 4. Reply detection

`check` moves a `waiting`/`unknown` follow-up to `replied` only when a stored
message proves it:

1. the message is not `outbound` and is newer than the anchor; **and**
2. its `in_reply_to` equals the anchor `message_id`, or its `references`
   contain the anchor `message_id`, or it shares the anchor `thread_root` and
   is a different message.

Everything else is deliberately conservative:

| Case | Result |
|---|---|
| `Auto-Submitted: auto-generated/auto-replied`, out-of-office subjects (`自动回复`/`自動回覆`/`Auto-Reply`/`Out of Office`), or mailer-daemon/postmaster/no-reply senders | `ignoredReplies[]`; never `replied` |
| Sender differs from the recorded counterparty **and** the domain differs | `possibleReplies[]` (`basis: thread+foreign-sender`) |
| Same counterparty, same subject after stripping `Re:`/`回复:`/`答复:`, within 30 days | `possibleReplies[]` (`basis: subject-window`) |
| Anchor has no thread headers (`thread_root IS NULL`) | `unknown` (`no-threading-headers`) |
| Anchor mail row was purged / is missing | `unknown` (`anchor-missing`) |
| No provable reply | stays `waiting` |

`replied` and `dismissed` are terminal: `check` never scans or reopens them
(`dismiss` accepts only `waiting`/`unknown`, `mark-replied` likewise; a repeated
identical `dismiss`/`mark-replied` is idempotent and reports
`alreadyDismissed`/`alreadyReplied`). Replies are reported per message as
`replies[]/ignoredReplies[]/possibleReplies[]` entries with `rowId`, `messageId`,
`receivedAt`, `from` and (for ignored/possible) a `reason`/`basis`.

## 5. Coverage: what "no reply found" means

`ls`/`show`/`check` include a `coverage` block:

```json
{ "syncedMailboxes": 2, "sentMailboxSeen": true, "basis": "headers", "warnings": [] }
```

- If the account has not synced a Sent mailbox, `sentMailboxSeen` is `false` and
  `warnings` contains `sent-mailbox-not-synced`. **A local `waiting` state is
  not proof that the mail was sent from this home**, and it is never presented
  as a sent-mail receipt.
- "No reply found locally" is not "the person did not reply": the message may
  not be synced yet, may have arrived in another mailbox, or may not carry
  thread headers. Do not quote the follow-up list as an external fact.
- `mail purge` removes bodies but not the follow-up rows (headers only), so the
  waiting list still works after a body purge; deleting the mail account leaves
  the rows and `check` reports `anchor-missing`.

## 6. Reminders, briefs and JSON

A follow-up is an ordinary third-party commitment, so it appears in `remind`,
`today`, `who` and `morning` through the existing waiting group, with the same
`dueAt`, `reminderOffsets` and quiet-hour behaviour as any other commitment; no
reminder/scheduler logic changed in 0.5.1. The human output must keep the
"local evidence only" caveat from §5.

JSON: each `mail followup` subcommand returns an additive schema under
`{ ok, command, … }`; the `followup` item is

```json
{ "id": "wr_…", "commitmentId": "cm_…", "accountId": "acc_…", "anchorRowId": 12,
  "anchorMessageId": "<…>", "threadRoot": "<…>", "counterparty": "client@example.com",
  "subject": "Q4 quote", "anchorAt": "2026-11-20T09:00:00+08:00",
  "dueAt": "2026-11-23T18:00:00+08:00", "state": "waiting", "daysWaiting": 4,
  "replies": [], "ignoredReplies": [], "possibleReplies": [], "warnings": [],
  "lastCheckedAt": "2026-11-24T10:00:00+08:00" }
```

`mail followup add --json` returns `{ok, command, followup, commitment,
dueBasis}` where `dueBasis` is `waiting-default` (the 3-day default) or `explicit`
(`--due`); the item may also carry the additive `repliedAt`, `repliedRowId`,
`dismissReason` and `dismissNote` fields when applicable. `check --dry-run`
returns `{ dryRun: true, checked, wouldChange[] }` and writes nothing (no state
change, no audit row, no `updated_at`). `check --json` in a real run returns
`changed[]` plus `checked`/`coverage`. See [CLI-JSON.md](CLI-JSON.md) for the
frozen shape.

## 7. Safety, privacy and audit

- No new network path and no new credential: the engine reads the same local
  ledger as `mail ls`/`mail show`.
- The audit chain records `followup.add|check|dismiss|mark-replied` with ids and
  counts only (no subject/body text in the reason), plus the normal commitment
  audit row from `add`.
- New local data is mail-thread header metadata and follow-up state; it never
  enters MCP/DSH/receipt/context-pack/Pet-Brief output. It travels only inside the
  normal user data plane (`export --all`, `backup`, bundle, sync), because
  `waiting_replies` is a user table in `DATA_TABLES` rather than a derived/local-only
  side file.

## 8. Limits / not in 0.5.1

- No send, no draft, no auto-chase, no IMAP write, no OAuth/Gmail/Microsoft 365,
  no background sync/IDLE and no daemon.
- No historical back-fill (pre-v23 mail rows stay `unknown`); no mailbox-wide
  "who owes me a reply" scan beyond the messages already synced; no
  cross-account thread merge.
- `possibleReplies[]` is a review queue, not an answer detector; only
  `mark-replied` (manual, audited) or exact header proof moves a follow-up.
- No MCP/DSH tool, resource, receipt or context-pack surface for follow-ups.

## 9. Verification

```sh
H=$(mktemp -d)
export ADVISERS_HOME="$H" ADVISERS_ACCEPT_TOS=1
# import three synthetic .eml files that form one thread (anchor + reply),
# then: add -> ls -> check -> replied, with no network
```

Automated coverage: `test/mail-parse-threading.test.js`,
`test/mail-thread-store.test.js`, `test/mail-followup.test.js`,
`test/bin-mail-followup.test.js` and `test/migration-v23.test.js` (v22 -> v23
backup/rollback, `DATA_TABLES`, export/import round-trip). `check --dry-run` is
asserted to leave the database, audit chain and `updated_at` untouched.

## 10. Error codes

| Code | When |
|---|---|
| `E_FOLLOWUP_EXISTS` | same anchor message + counterparty already has a `waiting`/`unknown` follow-up |
| `E_FOLLOWUP_NOT_FOUND` | unknown `wr_…` id |
| `E_FOLLOWUP_INVALID` | usage/argument error (bad `--state`, missing `--reason`, …) |
| `E_MAIL_MESSAGE_NOT_FOUND` | the anchor `--mail`/`--thread` id is not in the ledger |
| `E_DUE_UNRESOLVED` / `E_DUE_CONFLICT` | `--due` cannot be resolved (delegated to the shared due parser) |
| `E_SCHEMA_STALE` | the ledger is still v22 (run any writable 0.5.1 command to migrate) |

## Related

- [CLI-JSON.md](CLI-JSON.md) — machine-readable shapes.
- [MCP.md](MCP.md) — the unchanged 8-tool/5-resource surface (mail is not an
  MCP surface).
- [REMINDERS.md](REMINDERS.md) — how a follow-up surfaces through ordinary
  commitments.
- [ARCHITECTURE.md](ARCHITECTURE.md) — schema v23 and module map.
- [PRIVACY.md](PRIVACY.md) — the legal data-flow notice (unchanged in 0.5.1).
