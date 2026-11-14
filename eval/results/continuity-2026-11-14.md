# Continuity real-model run — 2026-11-14

Model: deepseek-flash, default CLI home, 10 stored facts + 8 recall probes.

- Before recall-intent fix: 4/8.
- After recall-intent fix: 6/8.
- After `said`/`searchFacts` fix: **8/8**.

Fixes involved:
- recall questions execute instead of asking for deadline/deliverable;
- conversation `said` facts no longer supersede each other;
- `searchFacts` accepts partial term hits for Chinese whitespace-free queries.

This is a 10-fact synthetic probe, not a 200-turn continuity test.
