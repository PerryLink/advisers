# Source schema v2 (E2)

Every candidate created by `capture`, `capture --from-mail`,
`capture --from-transcript`, or accepted into a commitment/fact/preference
keeps a pointer to the local input it came from. The schema is deliberately
small and versioned.

**v2** adds typed provenance fields and an explicit `sourceVersion` marker.
**v1** rows (the only shape written before 0.2.0) remain readable through a
compatibility mapping, so no stored evidence has to be rewritten.

## Status

- `packages/advisers/lib/source.js` implements `normalizeSource()`,
  `validateSource()`, `isSourceV2()` and `toLegacySource()`. The module is
  pure: it never touches the database, filesystem or network.
- **Write side (0.2.0 CLI)**: every capture path (`capture`, `capture
  --from-mail`, `--from-transcript`, `--from-imap`) builds one source per
  candidate, runs `normalizeSource()` and then `validateSource()`; an invalid
  source is rejected (the message is counted as `failed` for bulk imports, the
  command exits 1 for a single capture) instead of being written.
  - bare `capture` uses `type: "conversation"` plus the local turn reference
    (`ref: "<sessionId>#<turnId>"`) and the verbatim quote;
  - mail uses `type: "mail"` with `messageId`/`subject` (the IMAP
    `channel`/`uid`/`from` are preserved as extension fields);
  - transcript uses `type: "transcript"`, the `file` basename and the first
    speaker (`speakers[]` is mapped to `speaker`);
  - all writers add `capturedAt`; stored rows are v2.
- **Read side**: `today --sources` / `today --json --sources` and
  `evidence show <id> [--json]` normalise each stored source before display, so
  v1 rows (e.g. `type: "email"`) render as v2 (`type: "mail"`) without being
  rewritten in the database. There is no migration and no schema change.

## Shape

```json
{
  "sourceVersion": 2,
  "type": "conversation | mail | calendar | transcript",
  "quote": "verbatim excerpt from the input",
  "ref": "sessionId#turnId, or a calendar UID",
  "messageId": "optional RFC822 Message-ID",
  "subject": "optional mail subject or calendar summary",
  "file": "optional basename of the .eml/.vtt/.ics file",
  "mime": "optional MIME type, e.g. text/calendar",
  "speaker": "optional speaker/author for transcripts or meeting notes",
  "tStart": "optional ISO 8601 start of the referenced span",
  "tEnd": "optional ISO 8601 end of the referenced span",
  "capturedAt": "ISO timestamp when the local input was captured/imported"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `sourceVersion` | number | yes | Schema version; `2` for this shape. |
| `type` | string | yes | One of the four canonical types (defaults to `conversation`). |
| `quote` | string | one of quote/pointer | Verbatim excerpt; never paraphrased or repaired. |
| `ref` | string | one of quote/pointer | Local pointer: `session#turn` for conversation, calendar UID for calendar. |
| `messageId` | string | no | RFC 822 Message-ID for mail imports. |
| `subject` | string | no | Mail subject or calendar summary. |
| `file` | string | no | **Basename only** of the imported file; absolute paths are never stored. |
| `mime` | string | no | `type/subtype`, e.g. `text/calendar; charset=utf-8`. |
| `speaker` | string | no | Who said/wrote it, for transcripts and meeting notes. |
| `tStart` / `tEnd` | string | no | ISO 8601 span inside the source (event time, cue time); `tStart <= tEnd`. |
| `capturedAt` | string | no | ISO 8601 local capture/import time. |

Rules enforced by `validateSource()`:

1. A source must have at least one pointer (`ref`, `messageId` or `file`) **or**
   a non-empty `quote`; otherwise it is rejected as an invented source.
2. `file` is a basename. A path (`/`, `\` or `C:`) is a validation error;
   `normalizeSource()` reduces it to the basename defensively, but writers
   should never pass a path.
3. `mime` matches `type/subtype` and is lowercased by the normaliser.
4. `tStart`, `tEnd` and `capturedAt` must be ISO 8601 dates/datetimes and
   `tStart <= tEnd`.
5. Unknown `type` values are preserved with a warning instead of rejected:
   v1 used ad-hoc values (`user_explicit`, `import`, ...) that older rows carry.
6. Unknown fields are preserved as extensions (e.g. the IMAP `channel` /
   `from` / mail `uid`), so rendering older rows never silently drops
   provenance.

## Legacy mapping (v1 -> v2)

`normalizeSource()` accepts v1 rows and maps them:

| v1 | v2 |
|---|---|
| `type: "email"` | `type: "mail"` |
| `sessionId` (+ `turnId`) | `ref: "sessionId#turnId"` |
| `turnId` alone | `ref: "legacy#turnId"` (matches the evidence-pointing convention) |
| `uid` on a calendar source | `ref` |
| `speakers[]` | `speaker` (first non-empty entry) |
| `file: "dir/name.eml"` | `file: "name.eml"` |
| `from`, `channel`, mail `uid` (not part of the schema) | kept as extensions |

`toLegacySource()` is the lossy reverse edge for consumers that have not
migrated: it drops `mime`/`speaker`/`tStart`/`tEnd` (v1 never had them),
turns a calendar `ref` back into `uid`, and a transcript `speaker` back into
`speakers: [speaker]`. New rows must be written with `normalizeSource()`; use
`toLegacySource()` only at a compatibility boundary.

## Where it is stored

- `memory_candidates.evidence[]`: `{ quote, sessionId, turnId, source }` while pending
  (`source` is the v2 shape above for 0.2.0 writers; legacy rows keep the v1
  object and are normalised on read).
- `Commitment.evidence[]`: `{ sessionId, turnId, quote, source? }` after `memory accept`.
- `Fact.evidence[]` / `UserPreference.evidence[]`: `{ quote, ref: "session#turn", source? }`.
- `calendar_events`: `uid, summary, starts_at, ends_at, all_day, tzid, location, rrule, source`
  (the `source` column is the imported file basename; event times are columns,
  not a source object).

There is no new column and no migration: v2 is a shape inside the existing
`source` JSON object.

## Dedupe

`importers.dedupeKey(source, parsed)` hashes:

- mail: `messageId` when present, else normalized text;
- calendar: `uid`;
- transcript: normalized text;

with the source type mixed into the material. `capture --from-mail` /
`--from-transcript` record `seen_events(link_id='import', account_id='mail'|'transcript', key)`
for 30 days, so re-importing the same file does not create duplicate candidates.

## Invariants

1. **No invented sources.** A candidate without a real turn id is rejected at
   accept time (`evidence turn not found`), not silently accepted. Legacy rows
   without a `sessionId` are accepted with `sessionId: "legacy"` for migration;
   `normalizeSource()` points those at `ref: "legacy#<turnId>"`.
2. **No absolute paths** are stored in evidence. Only basenames/ids and quotes.
3. **Read-only imports.** Mail/calendar/transcript import never writes back to
   IMAP, CalDAV or the source file; the only write is the local
   candidate/event row.
4. **Secret matters fail closed.** `secrecy > 0` blocks capture/import/evidence
   export before any model/network call.

## Changing the schema

Bump `sourceVersion` and keep reading older versions; do not repurpose existing
fields. The planned marker is `sourceVersion: 2` (earlier drafts in this doc
called it `source_v: 2`; `normalizeSource()` accepts either spelling on input).
`evidence show` / `deliveries --pack` must remain able to render unknown fields
from older rows — hence the extension pass-through above.
