# Capture 150 synthetic regression — 6b354b4 (2026-11-14)

Command:
```sh
DEEPSEEK_API_KEY=*** ADVISERS_MODEL=deepseek-flash node eval/run-capture-150.mjs
```

Result (single run):
```json
{
  "cases": 150,
  "expected": 150,
  "found": 150,
  "recall": 1,
  "dueOk": 150,
  "dueRate": 1,
  "dueOkStrict": 150,
  "dueRateStrict": 1,
  "dueOkLegacy": 141,
  "dueRateLegacy": 0.94,
  "ambiguousCases": 9,
  "ruleDue": 120,
  "autoConfirmed": 0,
  "failureCount": 0
}
```

Notes:
- **Synthetic** corpus; never cite as a human benchmark.
- This is a regression check on the current tree, not a new capability claim.
- 0 auto-confirmed: candidates still require human accept.
- 9 same-weekday ambiguous cases reported with both natural/legacy readings.
