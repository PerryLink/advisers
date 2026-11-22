# Reminders / ICS / morning brief / scheduler

`advisers remind` is the delivery-side counterpart of `advisers tick`:

- `tick` updates local nudge rows and prints what is due in the next 7 days.
- `remind` computes the same due set with **six rule families** (`due-1d`,
  `due-today-09`, `due-today-18`, `overdue-daily`, `snooze-wake`, and `upcoming`)
  and can emit an `.ics` calendar, a local delivery log, or a signed opt-in webhook.
- 0.4.0 adds an explainable **urgency v1** score (`terms`/`whyNow`, model version 1)
  to remind/agenda/morning output, a deterministic **morning brief archive**, a
  **second scheduler block** for the morning brief and scheduler **status v2**.
- 0.4.3 adds ICS interop metadata (`VTIMEZONE`/`TZID`/commitment ids) to the CLI
  export and a per-commitment 24h notification cooldown (see below).

```sh
advisers remind                      # human view
advisers remind --json [--now ISO]   # scripts; pure read, never delivers
advisers remind --ics out.ics        # VEVENT + VALARM (custom offsets or -P1D, -PT1H)
advisers remind --deliver            # append to ~/.advisers/reminders.log + audit
                                     # + scheduler/status.json (lastRun)
advisers remind --deliver --notify   # + local notification adapter + optional webhook
advisers remind install              # write opt-in scheduler scripts + PRINT the OS plan
                                     # (dry-run by default; --apply executes it)
advisers remind install --apply [--schedule "0 9 * * *"]
advisers remind install --morning [--morning-time 08:30] [--morning-days 1-5] [--quiet-hours 22:00-08:00]
advisers remind uninstall [--apply]  # remove scripts; --apply also removes both own blocks
advisers remind status               # scripts/log + last runs (remind+morning) + OS plans

advisers morning [--json] [--now ISO] [--top 1..5]       # deterministic brief + top priority list
advisers morning --archive [--keep 1..365] [--out f]    # archive under ~/.advisers/briefs/
```

> Runtime quiet-hours/dedupe below are shipped in **0.4.1**; the per-commitment 24h
> notification cooldown is **0.4.3**; the 0.4.0 npm tarball only baked `--quiet-hours`
> into the scheduler script.

## Urgency v1 and `whyNow` (0.4.0, deterministic)

Urgency is a **derived, explainable ordering aid**, never a priority verdict. It is
computed at read time by the pure function `lib/urgency.js` (no SQLite, no network,
no filesystem, no model, no clock read when `--now` is injected) and attached as an
additive `urgency` object to: `remind --json` reminders, `agenda --json` commitment
items (including `overdue[]`, `days[].items`, `waiting[]`, `unscheduled[]`; calendar
items never get one), and the `morning --json` items / `top[]` list.

```json
{"id":"cm_...","modelVersion":1,"score":44,"level":"medium",
 "terms":[{"id":"overdue","contribution":36,"explain":"逾期 3 天"},
          {"id":"mine","contribution":6,"explain":"你答应对方"},
          {"id":"timed","contribution":2,"explain":"有具体时刻"}],
 "topFactors":["overdue","mine","timed"],"whyNow":"逾期 3 天 · 你答应对方 · 有具体时刻",
 "dueAt":"2026-11-21T18:00:00+08:00","excluded":false,"degraded":null}
```

`score` is exactly the sum of the named terms (clamped 0..100); levels are
`<25 low`, `25–49 medium`, `50–74 high`, `>=75 critical`. **Model version 1 is
frozen**: changing any weight or threshold requires bumping `modelVersion`.

| Term | Condition (Asia/Shanghai local day) | Contribution | Cap |
|---|---|---|---|
| `overdue` | due < now and open | `min(50, 30 + 2 × overdueDays)` | 50 |
| `due_today` | today, not overdue | 30 | 30 |
| `due_near` | 1–7 days out | `max(0, 24 − 3 × days)` | 21 |
| `third` | debtor is `third:*` (you can chase) | 10 | 10 |
| `mine` | debtor is `user`/`agent` (you promised) | 6 | 6 |
| `remind_offsets` | custom reminder offsets | `min(6, 2 × count)` | 6 |
| `age` | created > 14 days ago | `min(6, 1 + floor((age − 14) / 7))` | 6 |
| `timed` | dueAt has a specific time (not date-only) | 2 | 2 |

Rules and non-claims:

- `snoozed`/`done`/`dropped` items are excluded upstream and returned with
  `excluded: true` (neutral score), not scored.
- **`secrecy` is not an input** and never appears in `terms`/`whyNow` — urgency must
  not leak a protection level.
- Dirty data never throws: an unparseable/missing due date returns
  `{score:0,level:"low",terms:[],degraded:"urgency_failed"}`.
- `whyNow` is the joined `explain` strings, capped at 200 code points; it is human
  text and never enters ICS, webhook payloads, receipts or MCP.
- **`dataSha256` is unchanged**: urgency is attached after the deterministic brief
  hash is computed, so two runs of the same data still produce the same hash.
- This is a heuristic, not a science score. Do not treat it as a business priority
  decision or expose it as one.

## Per-commitment reminder offsets (0.2.0)

A commitment may carry `reminderOffsets: string[]` (core `Commitment` type;
optional, so pre-0.2.0 snapshots and old callers keep loading unchanged).
Each entry is a signed offset relative to the due instant, evaluated on the
**Asia/Shanghai wall clock** (UTC+8, no DST since 1991):

| Offset        | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `-1d`        | 1 local day before `dueAt`, same clock time                    |
| `-2h`        | 2 hours before `dueAt`                                         |
| `+90m`       | 90 minutes after `dueAt`                                       |
| `+0d09:00`   | 09:00 on the due day (day shift + wall-clock time)             |
| `-1d08:30`   | 08:30 on the day before the due day                            |

- The sign is mandatory. A time-of-day is only valid with the `d` unit; a
  zero-day time-of-day offset canonicalises to `+` (`-0d09:00` → `+0d09:00`).
- Lists are de-duplicated and capped at 24 entries. `parseReminderOffset` /
  `normalizeReminderOffsets` throw on invalid input; the rendering path is
  lenient and skips a malformed entry so one bad ledger row cannot hide every
  reminder.
- **No offsets means the old default**: two relative VALARMs `-P1D` and
  `-PT1H`, byte-identical to previous releases. This also applies to an empty
  list or an unparsable list (legacy fallback).
- The ICS event UID is stable and independent of the offsets:
  `<uidPrefix>-<commitmentId>-<dueAt>`. Editing offsets updates the same
  calendar event instead of creating a second one.

### ICS rendering

`toIcs` reads offsets from each reminder (`reminder.reminderOffsets`), falling
back to `options.reminderOffsets` and then to the legacy alarms. With offsets:

- one `VALARM` per offset, sorted chronologically (same-instant duplicates
  collapse);
- **absolute** triggers, because RFC 5545 requires `VALUE=DATE-TIME` for an
  absolute `TRIGGER`: `TRIGGER;VALUE=DATE-TIME:20261120T010000Z` (UTC form of
  the Asia/Shanghai instant);
- the alarm `DESCRIPTION` carries the commitment title plus a human label
  (`提前 1 天`, `当天 09:00`, …) — never the creditor, matter, evidence or
  message body. `SUMMARY`/UID/title behaviour is unchanged.

**0.4.3 CLI export metadata (opt-in in the library).** `advisers remind --ics` now
emits an explicit `VTIMEZONE` (`TZID=Asia/Shanghai`), a local-wall
`DTSTART;TZID=Asia/Shanghai:…`, an `X-ADVISERS-COMMITMENT-ID` property per event and
the opaque commitment id appended to every `VALARM DESCRIPTION` (` · 承诺 <id>`), so a
TickTick/Feishu/Outlook import keeps a match back to the local row. The library
`toIcs()` defaults (no `tzid`, no `alarmCommitmentId`) still produce the 0.4.2 bytes;
the event UID and `SUMMARY` behaviour is unchanged.

`buildReminders` attaches `reminderOffsets` to a reminder only when the
commitment is customised, so the historical reminder object shape is unchanged
otherwise. Resolution order: injected per-id state (`options.reminderOffsets`
Map/object/function, mirroring `snoozedUntil`), the commitment field, a
duck-typed `meta`/`ledger.getMeta('reminderOffsets:<id>')` hook, then
`options.defaultReminderOffsets`.

Library helpers: `parseReminderOffset`, `normalizeReminderOffsets`,
`describeReminderOffset`, `reminderAlarmTime`, `reminderAlarms`.

### Persistence

The core in-memory ledger stores the field through `addCommitment`,
`updateCommitment`, `toJSON` and `fromJSON`. Both on-disk stores round-trip it:

- `ADVISERS_STORE=json` keeps the field in `state.json`.
- The default SQLite store keeps it in `commitments.reminder_offsets` (JSON
  text). `NULL` means "never customised" and loads back as an absent field, so
  pre-0.2.0 commitments keep their exact shape; an explicit `[]` is preserved
  and falls back to the legacy alarms at render time. Corrupt or non-array JSON
  degrades to absent instead of breaking the ledger. Schema **v18** adds the
  column; opening a v17 database migrates it in place after writing a
  same-directory `state.db.before-migrate-v17-*` backup, and a newer schema is
  still refused. The CLI writes them through
  `addCommitment`/`updateCommitment`:

```sh
# one-off (strictly normalised with normalizeReminderOffsets; invalid input is rejected)
advisers commit add "发报价" --quote "周五前发" --due 2026-11-20T18:00:00+08:00 \
  --remind-offsets "-1d,-2h,+0d09:00"

# edit an existing commitment (updateCommitment; --no-remind deletes the optional field)
advisers commit edit <id> --remind-offsets "+2h"
advisers commit edit <id> --no-remind
```

  `--remind <offset>` is a single-offset alias of `--remind-offsets`. Because the
  CLI loads the ledger through `Ledger.fromJSON(store.load())`, `advisers
  remind --json` / `--ics` pick the stored offsets up automatically afterwards.

## Outbound webhook (opt-in, off by default)

`ADVISERS_NOTIFY_WEBHOOK` enables one additional delivery channel: an HTTP
`POST` with a JSON body. Unset/empty means **not configured** and behaves like
previous releases (local log only).

```sh
# POSIX
export ADVISERS_NOTIFY_WEBHOOK="https://hooks.example.com/advisers"
# PowerShell
$env:ADVISERS_NOTIFY_WEBHOOK = "https://hooks.example.com/advisers"
```

Payload (`Content-Type: application/json`):

```json
{
  "schema": "advisers.notify.webhook.v1",
  "count": 3,
  "levels": { "L1": 1, "L2": 1, "L3": 1 },
  "dates": ["2026-11-20", "2026-11-21"]
}
```

- Only **counts, levels and local due dates** leave the machine. Titles,
  creditor names, actions, evidence and quotes are never read by the payload
  builder (`summarizeReminders`).
- `sendWebhookNotification(reminders, options)` never throws for delivery
  problems. It returns a structured result:
  - `{ sent: true, channel: 'webhook', configured: true, status, payload }`
  - `{ sent: false, channel: 'webhook', configured: false, reason: 'not-configured' }`
  - `{ sent: false, channel: 'webhook', configured: true, error: 'network' | 'timeout' | 'http' | 'invalid-url' | 'unsupported-protocol', status?, detail? }`
- `http:` and `https:` URLs only; default timeout 5 s (`timeoutMs` override).
  An offline machine yields `error: 'network'` with a readable detail — the
  caller keeps the local reminder log and reports the channel honestly.
- The webhook is a user-configured endpoint, not a cloud push: Advisers itself
  never contacts a service on the user's behalf without this variable.
- CLI wiring: `advisers remind --deliver --notify` calls the local adapter and
  then `sendWebhookNotification(reminders)`. The reported channel is the local
  one (`log-only` when no local adapter is available), `webhook` when only the
  webhook sent, or `<local>+webhook` when both sent. When the webhook is **not**
  configured the command stays `log-only`/local exactly as before (no error,
  no network). A configured webhook that fails is reported on stderr while the
  local log/status stays authoritative.

### Standard Webhooks signature (0.4.0)

When `ADVISERS_NOTIFY_WEBHOOK_SECRET` is set, every delivery also carries
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) v1
headers (the **payload is byte-identical to the 0.3.2 body**):

| Header | Value |
|---|---|
| `webhook-id` | random UUID; idempotency key for the receiver |
| `webhook-timestamp` | Unix seconds at send time |
| `webhook-signature` | `v1,<base64(HMAC-SHA256(secret, webhook-id + "." + timestamp + "." + rawBody))>` |

- The secret is read from the environment only and is never written to disk, a
  script, the database, logs or the audit chain. `whsec_<base64>` (the Standard
  Webhooks convention) is decoded to key bytes; any other non-empty value is used
  **as raw UTF-8 key bytes** (useful for a passphrase, not base64).
- **No secret configured** (only `ADVISERS_NOTIFY_WEBHOOK` set): the webhook is
  still sent for backward compatibility, but the CLI prints one stderr warning and
  the delivery result reports `signing: "none"`. 0.5 is planned to require a secret.
- A malformed `whsec_...` secret (not valid base64) fails closed: the webhook is
  not sent and the structured result reports `error: "invalid-secret"` without
  echoing the value.
- There is **no retry queue/outbox** in 0.4.0: a failed delivery is reported in the
  structured result/status and the local log stays authoritative. Retry semantics
  belong to a later notification engine.
- Receiver verification (Node, no dependency):

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function keyBytes(secret) {
  // Mirror Advisers: whsec_<base64> decodes to key bytes; any other string is raw UTF-8.
  return secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8')
}

function verify(secret, headers, rawBody, nowMs = Date.now()) {
  const id = headers['webhook-id']
  const timestamp = Number(headers['webhook-timestamp'])
  const sig = headers['webhook-signature']
  if (!id || !Number.isFinite(timestamp) || !sig) return false
  if (Math.abs(nowMs / 1000 - timestamp) > 300) return false          // replay window
  const expected = createHmac('sha256', keyBytes(secret))
    .update(id + '.' + headers['webhook-timestamp'] + '.' + rawBody)
    .digest()
  for (const part of sig.split(/\s+/)) {
    if (!part.startsWith('v1,')) continue
    const got = Buffer.from(part.slice(3), 'base64')
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true
  }
  return false
}
```

Use `webhook-id` as a short-lived idempotency key (5-minute cache is enough) and
verify against the **raw request body**, not a re-serialized JSON object.

## User-level scheduler (opt-in, dry-run first)

`lib/scheduler.js` generates `crontab` / Windows `schtasks` registrations but
**never executes a system command**; the CLI layer applies a plan only when the
user asks for it. Every planner defaults to `dryRun: true` and returns the
change as data:

- `crontab`: `buildCronBlock`, `getCronEntry`, `addCronEntry`, `removeCronEntry`
  maintain one marker-delimited block (`# >>> advisers-remind >>>`) and leave
  every other crontab line untouched; `crontabReadCommand()` /
  `crontabWriteCommand(text)` describe the `crontab -l` / `crontab -` calls.
  `buildCronCommand({ nodeBin, cliPath, args })` shell-quotes paths with spaces
  and escapes `%` (special in crontab).
- Windows: `buildSchtasksCommand({ action: 'create' | 'delete' | 'query', taskName, command, time })`
  returns `{ command: 'schtasks', args: [...] }` — `/SC DAILY /ST HH:MM /F` for
  create. `planWindowsStatus` returns the query argv because "is it installed?"
  cannot be known without running it.
- `planScheduler({ platform, action, dryRun, ... })` dispatches to
  `planCronInstall`/`planCronUninstall`/`planCronStatus` or the Windows
  equivalents. `dryRun` only labels the plan; the planners never write system
  state either way.
- Inputs are validated: five cron fields, single-line command, safe marker,
  `HH:MM` task time, no newline injection into a crontab.

### CLI: dry-run first, `--apply` to register

`advisers remind install|uninstall|status` is the only layer that can execute a
system command, and it never does so by default:

```sh
advisers remind install                 # writes ~/.advisers/scheduler/remind.sh|ps1 + README
                                        # and PRINTS the OS plan (crontab -/schtasks argv)
advisers remind install --apply         # same, then executes the plan
advisers remind install --apply --schedule "0 9 * * *"   # custom five-field cron schedule
advisers remind install --morning [--morning-time 08:30] [--morning-days 1-5] [--quiet-hours 22:00-08:00]
                                        # also writes morning.sh|ps1 and a SECOND own block
advisers remind uninstall               # removes the local scripts
advisers remind uninstall --apply       # removes the scripts AND both own cron/Task Scheduler blocks
advisers remind status                  # scripts/logs + last runs (remind + morning) + OS plans
```

- `install` builds the plan with `planScheduler({ platform: process.platform,
  action: 'install', command: buildCronCommand({ nodeBin, cliPath }), schedule,
  time, dryRun: !apply })`; on cron platforms it reads the current `crontab -l`
  text before planning so every unrelated line is preserved.
- **Two independent blocks (0.4.0).** The reminder block uses the marker
  `# >>> advisers-remind >>>`; `install --morning` adds
  `# >>> advisers-morning >>>` (`30 8 * * 1-5` by default, weekdays only) and
  `scheduler/morning.sh|ps1`. Both write `morning --archive` and log to
  `morning.log` separately from `reminders.log`. `uninstall --apply` removes
  exactly the two own marker blocks; every other crontab line is byte-preserved.
  Task Scheduler uses `/SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:30 /F` for the
  morning block and keeps `/SC DAILY` for reminders.
- `uninstall` plans with `planSchedulerBlocks({ action: 'uninstall', markers })`
  (read-only crontab read, marker-delimited block removal) and removes the local
  scripts.
- `--quiet-hours HH:MM-HH:MM` is validated at install **and now gates runtime
  delivery**: `remind --deliver --notify --quiet-hours ...` still appends the
  local `reminders.log` line, but local/webhook notification channels are
  suppressed when `--now` falls inside the window (cross-midnight supported) and
  the channel is recorded as `quiet-suppressed` with an audit row. `--force-notify`
  bypasses the window for one explicit run. The generated remind script bakes the
  same flag in, so scheduled runs respect it too; `morning.sh`/`morning.ps1`
  always call `morning --archive` and are not gated.
- **Notification dedupe:** after a successful notify attempt the CLI records one
  `notify:dedupe:<commitment>|<bucket>|<rule>|<localDay>` meta row per delivered
  reminder (30-day pruning). A second `remind --deliver --notify` on the same local
  day is recorded as `deduped` and sends nothing unless `--force-notify` is passed.
  The log line is still written; dedupe state is local metadata only.
- **Per-commitment 24h cooldown (0.4.3):** `remind --deliver --notify` also skips a
  commitment whose notification was sent within the previous 24 hours
  (`notify:cooldown:<commitment>` meta row, 7-day pruning). When the whole batch is
  cooled the channel is recorded as `cooldown-suppressed`; a partially cooled batch
  sends the remaining reminders and lists the skipped count on stderr. The local
  `reminders.log` line is still written for every delivery, and `--force-notify`
  bypasses both the dedupe and the cooldown for one explicit run.
- `status` prints the scheduler directory/logs, the `readSchedulerStatusV2()`
  record (both `remind` and `morning` sections), and both OS plans
  (`planCronStatus` with the live crontab text, or the `schtasks /Query` argv on
  Windows — exit code 0 there means registered).
- A real `advisers remind --deliver` run (including one with zero due reminders)
  writes `recordSchedulerRunV2({ section: 'remind', result: 'ok', count, channel,
  dryRun: false })`, and `morning --archive` records the `morning` section (count +
  archive path), so `remind status` can prove the schedules actually fire. A
  missing/corrupt status file never blocks delivery.
- Once a cron/schtasks entry exists it calls `remind --deliver --notify` (or
  `morning --archive`); the `--notify` channel and the optional webhook are
  described above.

### Status file (v2, backward compatible)

`~/.advisers/scheduler/status.json` (0600, written atomically through a temp
file + rename) records the last real run of each section:

```json
{
  "version": 2,
  "remind": {"lastRun": "2026-11-21T09:00:00.000Z", "lastResult": "ok",
             "lastCount": 3, "lastChannel": "webhook"},
  "morning": {"lastRun": "2026-11-21T08:30:00.000Z", "lastResult": "ok",
              "lastCount": 3, "lastPath": "/home/me/.advisers/briefs/2026-11-21.md"},
  "updatedAt": "2026-11-21T09:00:00.000Z"
}
```

A 0.3.x **v1** file (`{version:1,lastRun,lastResult,lastCount,lastChannel}`) is still
read and mapped into the `remind` section without throwing; a missing/corrupt/partial
file degrades to defaults. `readSchedulerStatusV2({ homeDir })` is the read path,
`recordSchedulerRunV2({ section, at, result, count, channel|path, dryRun: false })`
the write path. Tests and callers always pass an explicit `homeDir`.

## Morning brief: top list and archive (0.4.0)

`advisers morning` stays deterministic (no model, no network, `dataSha256` of the
source data). 0.4.0 adds two additive views and one explicit write path:

- `--json` adds `top: [{id,kind,title,localTime?,urgency,whyNow,source:"today"|"overdue"}]`
  (at most `--top 1..5`, default 3; ordering `score desc -> dueAt asc -> id asc`) and
  `urgencyModelVersion: 1`. The full `mustDo` list keeps its 0.3.2 meaning and the
  markdown gains a `## 今天优先（最多 N）` section before `## 今天必须做`.
- `--archive` writes the markdown to `~/.advisers/briefs/<localDay>.md` plus a
  byte-identical `latest.md` (directory 0700, files 0600, atomic overwrite for the
  same day), records one `brief.archive` audit row (reason = local day, no body), and
  records the `morning` scheduler section. `--keep N` (default 14, 1..365) prunes
  only files matching `YYYY-MM-DD.md`; it never recurses and never deletes unrelated
  files. `--out` still writes a separate copy.
- **Retention/privacy:** archived briefs contain commitment titles and dates (no
  evidence quotes, no money, no mail/KB text). `purge <matter>` does **not** delete
  archived briefs (up to `--keep` days). `vault seal` encrypts the database, not
  `briefs/`, so a sealed vault can still have plaintext brief copies until they age
  out or you delete them. See [PRIVACY.md](PRIVACY.md).
- Scheduling: `remind install --morning` runs `morning --archive` on weekdays at
  08:30 by default. **Missed runs are not retried** (same as cron/Task Scheduler):
  if the machine is off at 08:30, that day has no archive; `status` only shows the
  last recorded run.

## Reachability and data-safety boundary (audited 2026-11-22)

- **No cloud push, no companion app, no retry/outbox.** Reachability is the local
  notification adapter plus the opt-in webhook; a missed scheduled run (machine
  off, cron/Task Scheduler skipped) is not replayed.
- **IM/phone reachability is not built in.** The only IM path is the optional,
  externally installed Hermes gateway via `advisers bridge --dir`: a foreground
  long-running process that exchanges plaintext JSON files with a local directory.
  Delivery is at-least-once by design; pairing, platform auth and approval UX stay
  on the Hermes side (Advisers has no approval-card UI). Without Hermes there is
  no IM or phone channel.
- **Backup/sync are manual whole-database operations.** `backup`/`restore` and the
  E2EE `sync push/pull` snapshots cover `state.db` (last-snapshot-wins, no merge,
  not continuous). They do **not** cover the plaintext files this page creates —
  `scheduler/status.json`, `reminders.log`, `morning.log`, archived briefs under
  `briefs/` — or the OS cron/Task Scheduler registration. A restored database does
  not restore the schedule or the brief archive. See [SYNC.md](SYNC.md).
- See [AUDIT-2026-11-22.md](AUDIT-2026-11-22.md) for the verified list.

## Design constraints

- **No background daemon by default.** `remind install` writes user-level
  scripts (`~/.advisers/scheduler/remind.sh`, `remind.ps1`) and a README; it does
  not register OS tasks unless the user passes `--apply`. The scheduler library
  above provides the explicit, reviewable registration step; nothing persists
  without the user's action, and `remind uninstall --apply` removes it again.
- **No implicit cloud push.** `.ics` is imported into the user's existing
  calendar; the calendar app owns the notification. `--deliver` writes a local
  log and an audit event. `--notify` is best-effort local
  (`ADVISERS_NOTIFY_CMD`, then macOS osascript / Windows Toast / WSL Toast /
  Linux notify-send); if none is available it reports `log-only` and never
  pretends a push happened. The webhook above is the only outbound channel and
  it is opt-in, structured and payload-minimal.
- **No sensitive payload in logs/audit/ICS/webhook.** Audit stores commitment
  ids/levels, not client names or message bodies; the ICS export carries only
  title/due/UID/alarm labels; the webhook body carries only counts/levels/dates.
- **Notification tooling is best-effort.** On a machine without
  `notify-send`/BurntToast (the current test hosts), `.ics` + OS scheduler log
  are the verification path; a native toast is an optional future adapter.
