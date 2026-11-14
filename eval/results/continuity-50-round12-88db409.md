# Continuity 50 — regression and fix (2026-11-14, HEAD 88db409)

Model: deepseek-flash; synthetic 50-fact set; probes 9; real API key (not stored).

## First run (before fix)

- facts 50, probes 9, **passed 8**, elapsed 682,009 ms.
- Failure: probe "我的周报偏好是什么？" — the agent tried to backfill several
  earlier facts via `memory_propose`, whose quote must be verbatim from the
  CURRENT user message; validation rejected them and the answer became a
  registration error instead of the preference.
- Diagnosis: prompt/tool contract gap, not a date/capture bug.

## Fix

Added an explicit system instruction in `lib/agent.js`:
> Use memory_propose ONLY for a fact stated in the CURRENT user message. Never
> re-propose facts from earlier turns while answering a question; answer from the
> existing ledger/history. If an earlier fact is missing, say so plainly instead
> of trying to backfill it from old messages.

## Second run (after fix)

```json
{ "facts": 50, "probes": 9, "passed": 9, "failures": [], "elapsedMs": 648509 }
```

Notes: single-run real-model probes; synthetic data; not a human benchmark.
The first run's failure is kept here deliberately as regression evidence.
