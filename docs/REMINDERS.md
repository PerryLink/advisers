# Reminders / ICS (E1)

`advisers remind` is the delivery-side counterpart of `advisers tick`:

- `tick` updates local nudge rows and prints what is due in the next 7 days.
- `remind` computes the same due set with **five rule families** (`due-1d`,
  `due-today-09`, `due-today-18`, `overdue-daily`, `snooze-wake`) and can emit
  an `.ics` calendar or a local delivery log.

```sh
advisers remind                      # human view
advisers remind --json               # scripts
advisers remind --ics out.ics        # VEVENT + VALARM (custom offsets or -P1D, -PT1H)
advisers remind --deliver            # append to ~/.advisers/reminders.log + audit
                                     # + scheduler/status.json (lastRun)
advisers remind --deliver --notify   # + local notification adapter + optional webhook
advisers remind install              # write opt-in scheduler scripts + PRINT the OS plan
                                     # (dry-run by default; --apply executes it)
advisers remind install --apply [--schedule "0 9 * * *"]
advisers remind uninstall [--apply]  # remove scripts; --apply also removes the cron/schtasks entry
advisers remind status               # scripts/log + last recorded run + OS registration state
```

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
advisers remind uninstall               # removes the local scripts
advisers remind uninstall --apply       # removes the local scripts AND the cron/schtasks entry
advisers remind status                  # scripts/log + last recorded run + OS registration state
```

- `install` builds the plan with `planScheduler({ platform: process.platform,
  action: 'install', command: buildCronCommand({ nodeBin, cliPath }), schedule,
  time, dryRun: !apply })`; on cron platforms it reads the current `crontab -l`
  text before planning so every unrelated line is preserved.
- `uninstall` plans with `planScheduler({ action: 'uninstall' })` (read-only
  crontab read, marker-delimited block removal) and removes the local scripts.
- `status` prints the scheduler directory/log, the `readSchedulerStatus()`
  record (`lastRun`/`lastResult`/`lastCount`/`lastChannel`), and the OS plan
  (`planCronStatus` with the live crontab text, or the `schtasks /Query` argv on
  Windows — exit code 0 there means registered).
- A real `advisers remind --deliver` run (including one with zero due
  reminders) writes `recordSchedulerRun({ homeDir, result: 'ok', count, channel,
  dryRun: false })`, so `remind status` can prove the schedule actually fires.
  A missing/corrupt status file never blocks delivery.
- Once a cron/schtasks entry exists it calls `remind --deliver --notify`; the
  `--notify` channel and the optional webhook are described above.

### Status file

`~/.advisers/scheduler/status.json` (0600, written atomically through a temp
file + rename) records the last real run:

```json
{
  "version": 1,
  "lastRun": "2026-11-17T09:00:00.000Z",
  "lastResult": "ok",
  "lastCount": 3,
  "lastChannel": "webhook",
  "updatedAt": "2026-11-17T09:00:00.000Z"
}
```

`readSchedulerStatus({ homeDir })` degrades to defaults for a missing, corrupt
or partial (pre-0.2.0) file instead of throwing; `recordSchedulerRun({ at, result,
count, channel, dryRun: false })` is the write path. A missing/corrupt status
file must never block reminder delivery. Tests and callers always pass an
explicit `homeDir`.

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
