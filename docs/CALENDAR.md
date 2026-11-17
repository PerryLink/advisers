# Calendar import and display (E2, read-only)

Advisers can read local `.ics` files and show the meetings that fall on the
current local day. There is **no CalDAV/OAuth account, no network call and no
write-back**: the only writes are the local `calendar_events` row and an audit
event, as in every other read-only import.

## Commands

```sh
advisers calendar import --ics cal.ics   # read-only import; prints "N events"
advisers today --calendar                # local events for today (Asia/Shanghai)
advisers today --json --calendar         # same, machine-readable (see CLI-JSON.md)
```

- `calendar import` parses the file with `importers.parseIcs()` and upserts each
  event by `UID`; re-importing the same file updates the stored row instead of
  duplicating it.
- `today --calendar` expands each stored row with `expandRrule(row, { from:
  today, to: today })` (read-only, bounded) and shows the occurrences that start
  today: timed events as `HH:MM`, all-day events as `全天`, and instances that
  came from an expanded RRULE with a `（循环）` marker. It never contacts a
  calendar server and never writes a row.
- Times are displayed in **Asia/Shanghai (UTC+08:00, no DST)**. The parser keeps
  the `.ics` wall time literally and exposes `TZID` as a marker; this package
  does not ship a time-zone database, so a non-Shanghai `TZID` is not converted.

## Recurring meetings (RRULE)

A recurring meeting is stored once (one `calendar_events` row with the RRULE
text verbatim — `importers.parseIcs()` deliberately does not expand it:
"it is evidence, not something to expand"). Before 0.2.0 that meant a weekly
meeting appeared in `today --calendar` **only on its DTSTART day**, because the
display filter matched the stored `starts_at` date.

`packages/advisers/lib/ical.js` fixes that with a pure, dependency-free
expander:

```js
import { expandRrule } from './lib/ical.js'

// One stored weekly row -> the occurrences that start today.
const today = expandRrule(row, { from: '2026-11-17', to: '2026-11-17' })
```

- **Input**: the row shape returned by
  `SqliteStore.listCalendarEvents()` (`uid, summary, startsAt, endsAt, allDay,
  tzid, location, rrule, source`) or the `parseIcs()` shape (`start, end,
  allDay, ...`). Optional `exdate`/`exdates` (string, comma-separated string, or
  array) removes excluded occurrences.
- **Output**: copies of the event with `startsAt`/`endsAt` formatted as
  `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM:SS+08:00` (timed), plus
  `recurring` (whether the instance came from an expanded rule),
  `seriesStartsAt` (the stored DTSTART) and `occurrenceIndex`.
- **Window**: `from`/`to` accept `Date`, epoch milliseconds, `YYYY-MM-DD`
  (a bare `to` date means the whole local day), or ISO/iCalendar timestamps.
  Defaults: DTSTART .. DTSTART + 366 days.
- **Time zone**: fixed Asia/Shanghai; `Z` UTC inputs are converted to the
  local wall clock before expansion.

### Supported RRULE subset

| Part | Support |
|---|---|
| `FREQ=DAILY`, `FREQ=WEEKLY` | yes |
| `INTERVAL` | positive integer, weeks/days stepped from DTSTART |
| `COUNT` | yes (counts DTSTART; excludes COUNT+UNTIL rules) |
| `UNTIL` | yes, DATE or DATE-TIME; inclusive |
| `BYDAY` | plain weekdays (`MO,TU,...`); as a filter for DAILY, as the weekday list for WEEKLY |
| `WKST` | yes (week boundary for WEEKLY `INTERVAL`) |
| `EXDATE` | simple exclusion by instant (timed) or date (all-day) |

Everything outside that subset is **not guessed**: MONTHLY/YEARLY rules, other
`BY*` parts (`BYMONTH`, `BYSETPOS`, `BYHOUR`, ...), ordinal `BYDAY`
(`1MO`), `COUNT` together with `UNTIL`, malformed rules, and RECURRENCE-ID
override components all fall back to the stored DTSTART occurrence. Showing one
real occurrence is safer than inventing wrong meeting times; `parseRrule()`
exposes a `reason` string so a caller can explain why.

DTSTART is always kept as the first instance of a series, even when it does not
match `BYDAY` (`FREQ=WEEKLY;BYDAY=MO,WE` with a Saturday DTSTART): RFC 5545
calls that combination undefined, and dropping the stored meeting would hide
real data.

### Amplification guard

`expandRrule()` returns at most **366 instances** per call (`MAX_INSTANCES`),
and the internal day/week scan is capped, so a hostile rule such as
`FREQ=DAILY;COUNT=100000` over a ten-year window costs a bounded amount of work.

### CLI integration

`lib/ical.js` ships the expander with its test suite (`test/ical.test.js`);
`today --calendar` (and `today --json --calendar`) is now wired to it:

- Every stored `calendar_events` row is expanded for the **current local day**
  window. Non-recurring rows are returned only when they start today; weekly /
  daily rows return the occurrence that starts today, so a weekly meeting no
  longer appears only on its DTSTART day.
- `allDay` rows print `全天`; an expanded occurrence prints `（循环）` after the
  summary. Unsupported/malformed rules fall back to the single stored DTSTART
  occurrence instead of guessing dates.
- Display order is chronological (all-day date strings sort before timed
  `+08:00` stamps); the header day, `今天：…` counts and the plain
  `advisers today` output are unchanged.
- The JSON view (`today --json --calendar`) exposes
  `calendar: [{uid,summary,startsAt,endsAt,allDay,recurring,location,rrule}]`
  with the same expansion.

## Storage and provenance

- `calendar_events`: `uid, summary, starts_at, ends_at, all_day, tzid, location,
  rrule, source, imported_at`. `source` is the imported file basename (see
  [`SOURCE-SCHEMA.md`](SOURCE-SCHEMA.md); absolute paths are never stored).
- Import audit: `audit action='calendar.import'`, reason `"N events"`.
- Dedupe: `UID` is the primary key; `importers.dedupeKey('calendar', event)`
  hashes the UID for the read-only import path.

## Not provided

CalDAV/Google/Outlook account sync, OAuth, calendar write-back, creating events
from commitments, attendee/room data, RRULE editing, time-zone conversion for
non-Shanghai `TZID`, and RECURRENCE-ID overrides. These require new product and
security decisions; do not describe this as "calendar sync".
