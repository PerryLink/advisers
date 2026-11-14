# Upstream DSH PR feasibility — 2026-11-14

Question: should Advisers submit a small PR to `deepseek-ai/deepseek-harness`?
User authorized external actions; this records the evidence-based decision.

## Decision: **do not submit**

Hard blockers (each independently sufficient):

1. `CONTRIBUTING.md` explicitly says external pull requests are not accepted
   ("We are sorry that we cannot accept external pull requests at the moment");
   the suggested channels are Discussions, plugins and articles.
2. The repository currently has **Issues and Pull Requests disabled**:
   public API reports `has_issues=false`, `has_pull_requests=false`;
   `/issues` and `/pulls` return HTTP 404 while `/discussions` works.
3. No fork PR has ever been merged: 2,599 `Merge pull request #N` commits in the
   local history come from `deepseek-harness/` (2,530) or `deepseek-ai/` (69)
   branches; **0 from any other owner**.
4. Even if PRs reopened, required checks demand a same-repo Issue reference,
   `kind/*` + `area/*` labels and 2 reviewer points — external users cannot
   create the issue/labels.

## Advisers protocol gaps checked (all read-only)

- `latest_reminder` role: not in DSH wire types; DSH already has
  `@deepseek-ai/dsh-time-context` injecting time/timezone. No small PR.
- `deepseek_web_search` / `deepseek_read_url`: DSH has web tools and a separate
  DeepSeek server-tool provider; server tools cannot be combined with local tools
  in one request, so this is not an agent-loop patch.
- `title` / `safety_check`: request-side top-level fields can be added by the
  existing public `deepseek-llm-api-extensions` plugin; response-side parsing is
  a provider-policy change, not a small external PR.
- `document` block / Files API: DSH's shared LLM layer converts every file to
  text before adapters ("Files are never dispatched natively"); supporting
  `document` requires a cross-package architecture change.

## What was done instead

No issue/PR/comment was created. The findings were recorded here and in the
handoff; if the upstream policy changes (or maintainers invite a PR), the smallest
candidate would be the `refusal` stop-reason forward-compat patch with mock-SSE
tests, but that still needs a same-repo issue under the current rules.
