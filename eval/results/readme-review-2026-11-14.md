# README review — 2026-11-14

Model: deepseek-flash, thinking high.

Findings led to README changes:
- reasoning persistence claim scoped to turns/summaries/audit/export/backup,
  explicitly excluding provider logs and OS crash dumps;
- "never auto-confirms" replaced with the concrete accept-required mechanism;
- research egress is described as an explicit command path;
- core/link dependency wording softened;
- added a Security boundary section.

Remaining model feedback is advisory, not a certification.
