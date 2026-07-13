# GitHub agent-merge reliability — runbook

Diagnostic + recovery guide for GitHub write-path failures hit by autonomous agent sessions on this repo. Read this first when an agent can't approve, merge, push, or open a PR against `sindre-ai/maskin`.

## Root cause — the 2026-07-11 incident

On 2026-07-11 two PRs (#1034 and #1042) reached `validated` with green CI mid-morning and then sat open for hours because no agent could complete the approve + squash-merge. The write path failed in five separate places across the day: the four GitHub MCP identities (`github`, `github_approver`, `github-sindre-ai`, `github-vaerksted-ai`) each failed in a different way — an anonymous per-IP 60/hr rate-limit with no token attached, `Authentication Failed: Requires authentication` on writes, a `403 Permission denied` on `git push` via the default credential-helper, and a `pull_number: expected number, received string` schema error — and `git push` itself failed once with the same 403. There was no session-start preflight, so every task rediscovered the outage on its own; every landing that day required a human hand. Baseline the day before: agents were landing PRs unattended; agent approve+merge success for the day: 0%.

## First-move diagnostic pattern — late-run 401 on a GitHub write

Before you touch credentials or permissions, run these two checks in order. Both are cheap and rule out the two dominant silent-failure modes on long agent sessions:

1. **Token-mint → write delta.** GitHub App installation tokens have a ~1h TTL. Sessions that mint once at start and reuse the same token across a multi-hour run hit 401 on any git-write attempted more than ~50 minutes later. If Δ (mint timestamp → write timestamp) > ~50 min, treat token expiry as the leading hypothesis and refresh before doing anything else.
2. **Installation-ID churn.** If the App has been reinstalled during the run, the cached installation ID has rotated out from under the session and even a re-mint against the stale install ID returns 401. A rising reinstall count during the session window means suspect installation-ID rotation.

Only after both come back clean should you suspect an actual credential or permission issue.

The mechanism is evidence-backed but the fix (mint-on-write refresh) is a leading hypothesis being validated in this bet, not a proven remedy — PR #980 proposed it and never merged. Take the diagnostic pattern above as durable; take any specific refresh implementation as provisional until this bet's T4 lands and closes the loop.

## Failure tags — set by every GitHub tool call, with a diagnostic hint per tag

Every GitHub tool failure carries one of these cause tags in session logs. The tag is the first thing to look at; each maps to a small, well-known set of root causes.

| Tag | Diagnostic hint |
| --- | --- |
| `missing-token` | No token attached — the request went out anonymous and hit GitHub's 60/hr per-IP unauthenticated rate-limit. Check the identity's env var is populated at session start; if the preflight below didn't fire, the identity is missing from the pool. |
| `anon-rate-limit` | Same root as `missing-token` from the caller's side (60/hr per-IP) but the identity looked configured. Verify the token actually reached the tool call — a stripped `Authorization` header or a wrong header name produces this. |
| `403-permission` | Token is valid but lacks the scope required for the operation. Check installation permissions (App identity) or token scopes (PAT identity). Also fires when branch protection rejects the write — read the response body before assuming missing scope. |
| `401-unauth` | Token was rejected as invalid. Run the first-move pattern above (token-mint delta, installation-ID churn) before assuming the token was revoked. Late-run 401 on an App identity is almost always expiry, not revocation. |
| `schema-validation` | Client-side bug — the arguments failed the tool's input schema (e.g. `pull_number: expected number, received string`). Not an auth failure. Read the error to find the bad argument and correct the caller. |
| `mergeable-blocked` | GitHub returned `mergeable: false` or an equivalent block. CI is red, a required review is missing, the branch is behind, or a required check is pending. Check the PR's merge state and required-status responses, not credentials. |
| `token-expired-mid-session` | App installation token minted at session start expired mid-run. This is the specific late-run 401 case the first-move pattern surfaces. The fix (T4) is to re-mint on write; until it lands, restart the session or force a mint refresh before retrying. |

## Fix plan — what this bet is landing, and what each slice mitigates

The bet ships five slices that together drive the agent approve+merge success rate from 0% (2026-07-11 baseline) to ≥99% over a 30-day window, with degraded identities surfacing before a task hits them. Each task below is the mitigation for one of the failure modes above:

- **T1 — Startup preflight health-check.** Runs a per-identity auth + write-scope probe at every session start across all four GitHub identities. On any failure it posts a single alert to Slack `C075JBZ65RT` before any task begins. Mitigates: `missing-token`, `anon-rate-limit`, `403-permission` at the identity-provisioning layer — degraded identities are announced once, not rediscovered N times per outage.
- **T2 — GitHub-native auto-merge.** Routes validated PRs through GitHub's own auto-merge (or merge queue) once CI + approval are satisfied, removing REST `merge_pull_request` from the agent's hot path. Mitigates: `mergeable-blocked` and any residual write-path fragility on the merge itself — the merge is performed by GitHub, not by an agent token that might have expired.
- **T3 — Approver ≠ PR-author with ordered fallback.** Encodes the approver policy as `approver ≠ PR author` with an ordered fallback across the four identities (`github_approver` → `github-vaerksted-ai` → …), so a single-identity outage does not block the merge. Mitigates: `401-unauth` / `403-permission` on the approving identity — the fallback attempts the next identity instead of stalling the PR.
- **T4 — Mid-session GitHub token refresh.** Validates mint-on-write as the leading hypothesis for the late-run 401 pattern. Refreshes the App installation token immediately before any write when the mint-age crosses the safety threshold. Mitigates: `token-expired-mid-session` at its source. Confidence is low until this task's outcome is captured — treat the refresh as provisional and keep the first-move diagnostic pattern above as the durable takeaway.
- **T5 — Failure classification at the tool-call layer.** Wraps every GitHub tool call so every failure carries one of the tags above (adds `token-expired-mid-session` to the pre-existing set). Mitigates: rediscovery cost — a tag gives the next agent (or human) the first-move hint without re-reading the raw error, and it lets us grep `token-expired-mid-session` to measure the mid-session-refresh outcome.

## References

- Parent bet: `GitHub agent-merge reliability: provision, validate, and de-risk the write path` (Maskin object `aed45792-18e6-4576-8c7d-edaa533016eb`).
- Diagnostic pattern source: knowledge article `GitHub App installation tokens (~1h TTL) cached at session start expire before mid-session merges` (Maskin object `c17369cf-bdea-46f6-a44c-862efbd0b620`).
- Incident insights: `Merge stage collapsed on 2026-07-11` (`f0ed5432-0c67-4051-89bd-7c834e28ae5f`), `Four GitHub identities failed four different ways on 2026-07-11` (`d44c3e10-5648-4330-9ae3-f2d9f421c91c`).
- Related PRs: #1034 and #1042 (blocked on 2026-07-11 — required one-time human merge), #980 (proposed mint-on-write refresh, never merged), #998 (`Fix GitHub App installation tokens going stale on long agent sessions`).
