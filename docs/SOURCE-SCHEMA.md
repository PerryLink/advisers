# Source schema v1 (E2-T5)

Every candidate created by `capture`, `capture --from-mail`, `capture --from-transcript`,
or accepted into a commitment/fact/preference keeps a pointer to the local input it
came from. The schema is deliberately small and versioned:

```json
{
  "type": "conversation | mail | calendar | transcript",
  "quote": "verbatim excerpt from the input",
  "ref": "sessionId#turnId",
  "messageId": "optional RFC822 Message-ID",
  "subject": "optional mail subject",
  "file": "optional basename of the transcript/ics file",
  "uid": "optional calendar UID",
  "capturedAt": "ISO timestamp"
}
```

## Where it is stored

- `memory_candidates.evidence[]`: `{ quote, sessionId, turnId, source }` while pending.
- `Commitment.evidence[]`: `{ sessionId, turnId, quote, source? }` after `memory accept`.
- `Fact.evidence[]` / `UserPreference.evidence[]`: `{ quote, ref: "session#turn", source? }`.
- `calendar_events`: `uid, summary, starts_at, ends_at, all_day, tzid, location, rrule, source`.

## Dedupe

`importers.dedupeKey(source, parsed)` hashes:
- mail: `messageId` when present, else normalized text;
- calendar: `uid`;
- transcript: normalized text;
with the source type mixed into the material. `capture --from-mail` / `--from-transcript`
record `seen_events(link_id='import', account_id='mail'|'transcript', key)` for 30 days,
so re-importing the same file does not create duplicate candidates.

## Invariants

1. **No invented sources.** A candidate without a real turn id is rejected at accept
   time (`evidence turn not found`), not silently accepted. Legacy rows without a
   `sessionId` are accepted with `sessionId: "legacy"` for migration only.
2. **No absolute paths** are stored in evidence. Only basenames/ids and quotes.
3. **Read-only imports.** Mail/calendar/transcript import never writes back to IMAP,
   CalDAV or the source file; the only write is the local candidate/event row.
4. **Secret matters fail closed.** `secrecy > 0` blocks capture/import/evidence export
   before any model/network call.

## Changing the schema

Add a version prefix (`source_v: 2`) and keep reading v1; do not repurpose existing
fields. `evidence show`/`deliveries --pack` must remain able to render unknown fields
from older rows.
