# CLI JSON contract v1 (E6-T1)

Advisers is CLI-first. Scripts should be able to consume every read-only view without
parsing human text. Current JSON surfaces (2026-11):

| Command | Shape (top-level) | Stable? |
|---|---|---|
| `advisers status --json` | `{version,node,office,home,store{type,path},model,matters,prefs,routines,links,sessions,deliveries,soul,modelUsage?}` | v1 |
| `advisers tick --json` | `{now,localDay,due[]}` | v1 (existing) |
| `advisers remind --json` | `{now,reminders[]}` | v1 |
| `advisers commit ls --json` | `Commitment[]` | v1 |
| `advisers who --json` | `{mine[],waiting[]}` | v1 |
| `advisers deliveries --json` | `Delivery[]` | v1 |
| `advisers evidence show <id> --json` | `{commitment|fact|preference,sources[],missing[]}` | v1 |
| `advisers privacy --json` | data/egress facts | v1 |
| `advisers export [--all]` | ledger JSON / ledger+SQLite tables | existing |
| `advisers verify <file> ...` | verification JSON | existing |
| `advisers office-edit ...` | `{ok,out,changes}` | existing |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | user/config/runtime error (bad args, missing key, unknown id, failed verification) |

Future codes must not reuse `1` for a different meaning; add new codes only with a
version bump. JSON mode must never mix human prose into stdout; diagnostics go to
stderr. `--json` must not require a TTY.

## Examples

```sh
advisers status --json | jq .version
advisers remind --json | jq '.reminders[] | {action,bucket,level}'
advisers evidence show cm_xxx --json | jq '.sources[0]'
```
