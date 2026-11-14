# Reminders / ICS (E1)

`advisers remind` is the delivery-side counterpart of `advisers tick`:

- `tick` updates local nudge rows and prints what is due in the next 7 days.
- `remind` computes the same due set with **five rule families** (`due-1d`,
  `due-today-09`, `due-today-18`, `overdue-daily`, `snooze-wake`) and can emit
  an `.ics` calendar or a local delivery log.

```sh
advisers remind                      # human view
advisers remind --json               # scripts
advisers remind --ics out.ics        # VEVENT + VALARM (-P1D, -PT1H)
advisers remind --deliver            # append to ~/.advisers/reminders.log + audit
advisers remind --deliver --notify   # + local notification adapter
advisers remind install              # write opt-in scheduler scripts
advisers remind uninstall
advisers remind status
```

## Design constraints

- **No background daemon by default.** `install` only writes user-level scripts
  (`~/.advisers/scheduler/remind.sh`, `remind.ps1`) and a README; it does not
  register OS tasks without the user doing so. This keeps the local-first promise
  and avoids surprising persistence.
- **No cloud push.** `.ics` is imported into the user's existing calendar; the
  calendar app owns the actual notification. `--deliver` writes a local log and
  an audit event. `--notify` is best-effort local: `ADVISERS_NOTIFY_CMD`, then
  macOS osascript / Windows Toast / WSL Toast / Linux notify-send; if none is
  available it reports `log-only` and never pretends a push happened.
- **No sensitive payload in logs/audit.** Audit stores commitment ids/levels, not
  client names or message bodies.
- **Notification tooling is best-effort.** On a machine without
  `notify-send`/BurntToast (the current test hosts), `.ics` + OS scheduler log are
  the verification path; a native toast is an optional future adapter.
