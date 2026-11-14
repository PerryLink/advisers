# Real-model end-to-end acceptance (2026-11-14)

Model: `deepseek-flash` (single run, real API key; key not stored in repo).
Environment: WSL2, temp `ADVISERS_HOME`, no Microsoft Office; PDF uses system CJK font.

## Flow

1. `.vtt` transcript with two explicit commitments imported via
   `advisers capture --from-transcript meeting.vtt`.
2. Both candidates stayed pending, then `advisers memory accept <id>`.
3. `advisers evidence show <cm_...> --json` resolved a real `sessionId#turnId`
   and the transcript source metadata.
4. `advisers deliveries --pack --out pack` wrote `manifest.json`, `README.txt`,
   `SHA256SUMS`, `receipt.docx`; verification `{ok:true,errors:[]}`.
5. `advisers deliver --format pdf --out report.pdf` wrote a Chinese PDF.
6. `advisers remind --ics remind.ics` wrote 2 VEVENTs with VALARM.

## Observed

```
transcript import: 2 candidates
cand_mwgewnim_rxhgau firm 发报价 · 2026-11-20
cand_mwgewnim_0jm2fz firm 发最终方案 · 2026-11-18
accepted cand_mwgewnim_rxhgau
accepted cand_mwgewnim_0jm2fz
cm_mwgewr27_1 open 2026-11-20T15:59:59.000Z 发报价
evidence: sessionId "local", turnId "turn_ceaa216a6bcf4bde", source.type "transcript"
pack: manifest.json/README.txt/SHA256SUMS/receipt.docx, verify ok
pdf: report.pdf (PDF 1.7, system CJK font)
ics: remind.ics (2 events)
```

## Notes / limits

- This is a **single-run smoke**, not a benchmark; no independent human labeling.
- The first transcript fixture used requests (“把报价发我”) rather than explicit
  commitments and correctly produced 0 candidates. The product does not force
  candidates from non-commitment speech.
- The default `capture --source meeting` on the same explicit text also produced
  two pending candidates, confirming the text path.
- No IMAP/cloud account was used in this run; IMAP is covered by the mock-server
  unit test only.
