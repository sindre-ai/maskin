/**
 * Pilot corpus fixture — the seven v1 knowledge nodes T9 authored on the
 * agent-pipeline domain, mirrored to disk so the paired harness (T8) and
 * router (T10) can score them without pulling from the object graph.
 *
 * Why on-disk. The measurement gate for this bet runs against the pilot
 * corpus (bet AC #4, kill criterion). The first paired run (2026-07-16,
 * bet comment 288259) lived only as prose — not reproducible for the
 * 2026-08-13 verdict. Canonicalising the corpus + queries here lets any
 * future run of T8's paired runner re-derive the same numbers.
 *
 * Reference set (7 knowledge nodes, all v1, all `topic:agent-pipeline`,
 * bodies + metadata mirrored verbatim from the object graph at commit
 * `bet/context-engineering-format@16379036` — 2026-07-16):
 *   544a5c4e — Index (agent-pipeline, doc_type=index)
 *   81948ac6 — Telemetry payload trim (playbook)
 *   09dc15a8 — Hot-path async safety (playbook)
 *   7c23eaf4 — CR bet-level review scope (operational)
 *   3062b2c9 — Ship the DB index in the same PR as the query (playbook)
 *   9a02894c — CR fix-category mix tracks queue mix (operational)
 *   d3816268 — React identity-stability (playbook)
 *
 * Fixture invariants (module-level self-check enforces):
 *   - 7 corpus entries, 7 eval pairs (one per row).
 *   - Every `EvalPair.expectedFixtureId` resolves to exactly one entry.
 *   - Every `expectedExcerpt` appears in the title or body of its gold
 *     row — same grading contract T4/T8 use.
 *   - Article ids are stable, ascending strings — deterministic router
 *     tiebreak (see `apps/dev/src/lib/knowledge/router.ts`).
 *   - Every row carries `format_version: 'v1'` so T10's router surfaces
 *     it under the v1 filter.
 *
 * Do not reorder, trim, or extend this fixture — the ship-metric
 * baseline rides on the exact corpus + query set.
 */

import type { RepresentativeArticle, RepresentativePair } from './knowledge-eval-representative'

// Pin to the branch head at pilot-authoring time (bet comment 288182,
// 2026-07-16). Any future run can re-derive against this commit.
export const PILOT_SOURCE_COMMIT = '16379036a86d1cca82ea15a9fce7d1478a05d0b6'
export const PILOT_SEED = 'bet/context-engineering-format:pilot-t9-v1'

export const PILOT_CORPUS: readonly RepresentativeArticle[] = [
	{
		fixtureId: 'p01-index-agent-pipeline',
		title: 'Index — agent-pipeline operational + playbook knowledge (v1 pilot)',
		body: 'Layer-3 index for the agent-pipeline domain. Materialised catalog is the set of `derived_from` edges from this node to v1 articles; `covers` (in metadata) is the human-readable membership rule the lint reconciles against. No free-authored body — by design, per the v1 index format ([`docs/reference/knowledge-format.md`](https://github.com/sindre-ai/maskin/blob/task/t7-v2-format-three-layers/docs/reference/knowledge-format.md)). Router reads the summary and the summaries of the six catalogued articles first, then pulls only the article bodies it decides it needs.\n\nMembership rule (v1 tag-filter shape): any `type=knowledge` row with `metadata.format_version=v1`, `metadata.tags` including `topic:agent-pipeline`, and `metadata.doc_type` in {`operational`, `playbook`}.',
		metadata: {
			format_version: 'v1',
			doc_type: 'index',
			tags: ['topic:agent-pipeline', 'index:operational-playbook', 'provenance:writer', 'pilot:t9'],
			scope: 'workspace',
			summary:
				'Catalog of v1 operational and playbook knowledge for the agent pipeline: Code Reviewer fix-category patterns, developer-agent guardrails (hot-path async, telemetry hygiene, DB-index shipping, React memoization), and Code Reviewer scope-expansion (bet-level policy gating). Router entrypoint for topic:agent-pipeline queries. Six articles indexed as of 2026-07-16, all with format_version=v1. Membership defined by covers.tag=topic:agent-pipeline and doc_type in {operational, playbook}.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'p02-telemetry-payload-trim',
		title: 'Code-review pattern: telemetry surfaces leak more data than the signal requires',
		body: '## Conclusion\n\nWhen adding a log line, analytics event, or trace span, trim the payload to the minimal field that supports the metric. Shipping the raw input — meeting URLs, comment bodies, request payloads — into stdout logs, PostHog, or similar surfaces is a recurring SHOULD-flag in code review. The data is rarely needed for the question the instrumentation is supposed to answer, and the surface (log aggregator, product analytics) is a wider blast radius than the originating endpoint.\n\nTreat "what\'s the minimum I need to compute this signal?" as a required step when wiring telemetry, the same way you\'d treat input validation at a trust boundary.\n\n## The two observed instances (June 2026)\n\n1. **Skjald `POST /api/bots`** — `[BotCreate]` stdout log included `body.meetingUrl`. Google Meet / Zoom join URLs function as bearer tokens (anyone with the URL can join). The log only needed `id`, `workspaceId`, `platform` to be diagnostically useful. Fix: drop `url=` from the format string.\n2. **`comment_posted` PostHog event (PR #707)** — `properties.content` shipped the raw comment text to product analytics. The downstream query only asked `CONTAINS \'\\n\'`. Fix: emit a derived `properties.has_newline` boolean and drop the body.\n\nBoth were APPROVE-with-SHOULDs in Code Reviewer, not blocks. Both authored by the same engineer (Senior Developer). First time PII-in-observability has appeared as a fix-category in the workspace\'s weekly code-review-pattern insights.\n\n## The check to apply before merging telemetry changes\n\nFor every new log line / analytics event / trace attribute, answer two questions:\n\n- **What question is this signal answering?** (e.g. "do users post multi-line comments?", "which platform is the bot for?")\n- **What is the minimal value that answers it?** (boolean, enum, count, id — not the raw input)\n\nIf the field being shipped is wider than the answer (a URL where a platform enum suffices, a comment body where a `has_newline` boolean suffices), trim it. Bearer-style identifiers — meeting URLs, signed S3 URLs, share links, magic-link tokens — never go into logs or analytics. PII-bearing free text (comment bodies, message contents, names, emails) gets derived into a categorical before it\'s emitted.\n\n## Why this surfaces in review and not earlier\n\nFeature code gets scrutinized for input validation at the request boundary; observability code rarely does because it feels read-only. But a log line shipping `body.meetingUrl` to a log aggregator is functionally an outbound data flow — the surface area is just less obvious. The PR review caught both; the original write did not. Worth a pre-merge self-check on instrumentation PRs.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: [
				'provenance:writer',
				'code-review-pattern',
				'observability',
				'pii',
				'security',
				'telemetry-hygiene',
				'topic:agent-pipeline',
			],
			scope: 'product-area',
			summary:
				'When wiring telemetry (logs, PostHog events, traces), trim the payload to the minimal value that supports the signal. Recurring code-review SHOULD-flag in June 2026: bearer-style meeting URLs in stdout logs and raw comment bodies in PostHog events — both fixable by emitting an id, enum, or derived boolean instead of the raw input. Bearer-style URLs and PII-bearing free text never go into observability surfaces unaltered.',
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'p03-hot-path-async-safety',
		title:
			'Hot-path async safety: account for caller timeout budgets and worst-case retry semantics',
		body: "## Conclusion\n\nWhen wiring a slow operation into a fast-return caller (webhook ack, user-facing redirect, optimistic UI), the Developer agent must explicitly reason about the caller's timeout budget and worst-case retry semantics — not just the happy path. `await` inside a latency-sensitive path is a code smell until proven safe.\n\n## The pattern\n\nThree distinct PRs in a 48h window (May 2026) hit variations of the same shape — Code Reviewer caught each as a SHOULD, none blocked ship:\n\n1. **Webhook handlers with serial fan-out.** A handler awaits work that can exceed the upstream's ack window. PR #458: `MAX_FILES_PER_EVENT (20) × DOWNLOAD_TIMEOUT_MS (30s)` = ~10 min before Slack ack, but Slack retries after 3s — produces duplicate `files` rows and S3 objects on retry.\n2. **Best-effort writes awaited before user-facing response.** PR #462: click-log insert awaited before `c.redirect`, making every redirect as slow as the DB. Comment claimed best-effort; the code wasn't.\n3. **Optimistic UI without per-id rollback.** PR #454: `applyOptimisticBulkPatch` flips all selected ids to the new status, then waits for `onSettled` to refetch — failed rows display the wrong status for the duration of the round-trip.\n\n## Fixes by shape\n\n- **Fan-out in a fast-ack path:** ack first, then do work — or `Promise.allSettled` if the budget allows. Never serial `await` in a loop.\n- **Best-effort side-effects:** `void fn().catch(log)` — don't await, but capture errors.\n- **Optimistic mutation of N items:** track per-id state and roll back on per-id `onError`/`onSuccess`, not bulk `onSettled`.\n\n## The underlying failure mode\n\nDeveloper agent reasons locally about the new code's correctness and skips the question \"what is the caller's deadline, and what happens if I miss it?\" Idempotency and retry semantics of the upstream caller are the missing input.\n\n## Heuristic for review and authoring\n\nBefore adding `await` inside a request handler, webhook, or UI mutation, answer:\n1. What is the caller's timeout / ack deadline?\n2. What does the caller do on timeout — retry, fail, both?\n3. If retried, is this operation idempotent?\n\nIf any answer is unknown or unfavorable, move the work off the hot path or fire-and-forget with error capture.",
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: [
				'provenance:writer',
				'code-review-pattern',
				'hot-path-async',
				'developer-agent',
				'performance',
				'fix-category',
				'topic:agent-pipeline',
			],
			scope: 'product-area',
			summary:
				"When a Developer agent wires a slow operation into a fast-return caller, it must explicitly account for the caller's timeout budget and retry semantics. Three SHOULDs in 48h showed the same shape across webhook fan-out, awaited best-effort writes, and bulk optimistic UI — fixed respectively by post-ack fan-out, fire-and-forget with error capture, and per-id rollback.",
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'p04-cr-bet-level-scope-expansion',
		title:
			"Code Reviewer's review surface has expanded from diff-level to bet-level: provenance and policy-reversal are now gating concerns",
		body: "## Rule\n\nThe Code Reviewer has begun issuing BLOCK verdicts on **bet-level / governance-level** grounds — not on code defects. As of 2026-05-21 (PR #442 \"fix(mcp): re-enable notification tools\"), CR will refuse approval if:\n\n1. The **originating insight** for the bet was previously **discarded** by Insight Triage (e.g. flagged as a suspected prompt-injection signal) and the discard was never reconciled.\n2. The PR **reverses a previously-ratified workspace policy** without a corresponding human-authored signal that the policy has changed.\n\nThe verdict on PR #442 was BLOCK despite the diff being mechanically clean (0 MUST / 0 SHOULD / 0 NIT on code quality). The block was on the *premise of the work*, not the work itself.\n\n## Why this is novel\n\nEvery prior `code-review-pattern` finding in this workspace lived at the diff level — missing error handling, missing tests, security holes, stale base, performance gaps, accessibility, etc. This is the first time CR has gated on:\n- *Was the reason this code exists legitimate?*\n- *Does it reverse a previously-ratified workspace policy?*\n- *Does its originating insight have provenance the human has signed off on?*\n\nThat's the class of judgment a CTO or product owner typically applies at bet-end, not what a code reviewer applies at PR-end.\n\n## How to apply\n\n- **Treat bet-level gating as a feature, not noise.** Don't suppress it by narrowing CR's context. If anything, the implementer-task review should also pull upstream context (originating insight status, policy-reversal check).\n- **Don't auto-create bets off discarded insights.** The auto-bug pipeline should respect Insight Triage's `discarded` status — at minimum, refuse to advance without re-triage or human reconciliation.\n- **Make policy reversals an explicit signal.** PRs that touch files implementing a ratified workspace policy (e.g. anything reverting a commit referenced by the May 2026 CLAUDE.md priority) should require a corresponding policy-change signal in the bet or in CLAUDE.md before CR considers approval.\n- **On verdict conflict between twin surfaces, the stricter verdict (BLOCK) should win** until conflict resolution is formalized. The wider-context review is the one to trust, not the cheaper one.\n\n## Generalizable lesson\n\nWhen an agent's review responsibility is defined narrowly (\"does the diff meet the brief\") but the agent has access to wider context, expect the agent to occasionally apply that wider context — and the resulting judgments can be qualitatively new categories of finding. Two responses are reasonable: (a) explicitly broaden the agent's documented scope to match what it's already doing, or (b) explicitly narrow the agent's context to keep its judgments aligned with its documented scope.",
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'provenance:writer',
				'code-review-pattern',
				'bet-level-policy-gate',
				'governance-review',
				'prompt-injection-defense',
				'agent-scope-drift',
				'context-window-dependent-judgment',
				'new-finding-type',
				'topic:agent-pipeline',
			],
			scope: 'workspace',
			summary:
				"Code Reviewer began issuing BLOCK verdicts on bet-level grounds — not code defects — as of 2026-05-21 (PR #442). Two triggers: (1) originating insight was discarded (prompt-injection) and never reconciled, (2) PR reverses a ratified workspace policy without a change signal. Catch is context-dependent — only fires when the review task has wider graph context. Response: broaden CR's scope or close the upstream gap (no bets off discarded insights).",
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'p05-ship-db-index-with-query',
		title:
			'Ship the index in the same PR as the query: missing-DB-index is an emerging Code Reviewer SHOULD category (JSONB filter, composite, correlated subquery)',
		body: "## Rule\n\nWhen a PR introduces a **new query shape** in a route — a new filter column combination, a JSONB path filter, or a join/subquery pattern not previously exercised — the **supporting index ships in the same PR**. The pre-flight question for the author (not just the reviewer) is: *\"what does this query plan look like at 50k rows?\"*\n\nThe Code Reviewer now catches this class as a SHOULD finding (confidence 6–7/10), non-blocking on the merge SHA but flagged because it is the cohort of issues most likely to surface as a **production incident after merge**, when the workspace has scaled past the dev-fixture dataset.\n\n## The three shapes to recognise\n\n### 1. JSONB path filter with no supporting expression index\n\n```sql\n-- query\nWHERE sessions.config->'mention'->>'object_id' = $1\n  AND workspace_id = $2 AND status = $3\n```\n\n**Fix recipe:** partial expression index, guarded by a JSONB existence predicate so it stays tight:\n\n```sql\nCREATE INDEX sessions_mention_object_idx\n  ON sessions ((config->'mention'->>'object_id'))\n  WHERE config ? 'mention';\n```\n\n### 2. New filter column combination missing a composite index\n\n```sql\n-- query\nWHERE workspace_id = $1 AND entity_id = $2\nORDER BY id DESC LIMIT 100\n\n-- existing index: events_ws_created_at_idx (workspace_id, created_at)\n-- → no usable prefix; scans wide slice on busy workspaces\n```\n\n**Fix recipe:** composite index matching the new filter prefix, and the ORDER BY if it can ride the same index. The trap: an existing `(workspace_id, X)` index does **not** cover a new `(workspace_id, Y)` filter — the leading column matches but selectivity collapses to whatever workspace_id alone gives you.\n\n### 3. Correlated subquery that scales O(N × M)\n\nJoin pattern where each outer row triggers a per-`(entity_type, entity_id)` lookup against another table (e.g. `events` ⨝ correlated `read_state` subquery in an unread-feed listing). Acceptable for v1 with bounded inputs; flagged for revisit when the feature goes workspace-wide. The architectural fix is usually a rewrite to a single join or a denormalised counter, not an index.\n\n## Where to look first when triaging a PR\n\n- **Any new `WHERE` clause that combines columns differently from the existing index list.** Read the file's nearest `CREATE INDEX` statements (or the migrations directory) and check whether the new filter columns have a usable index prefix. Don't assume an existing `(workspace_id, X)` index covers a new `(workspace_id, Y)` query.\n- **Any `->` / `->>` JSONB extraction in a `WHERE` clause.** Default position: this needs a partial expression index, gated by a JSONB existence predicate so the index stays tight.\n- **Any subquery in a `SELECT` or `JOIN` that references the outer row.** Compute the worst-case cardinality and ask whether it scales with workspace size.\n\n## The checklist-able question\n\nBoth of the two index-shape findings (PR #424, PR #416) would have been caught pre-review by the author asking *\"what does this query plan look like at 50k rows?\"* before submitting. That question belongs on the author-side pre-flight, not just the reviewer's pass. The reviewer catches it after the fact; the author can prevent it.",
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: [
				'provenance:writer',
				'code-review-pattern',
				'new-fix-category',
				'emerging-pattern',
				'performance',
				'missing-db-index',
				'jsonb-index',
				'composite-index',
				'correlated-subquery',
				'postgres',
				'backend',
				'topic:agent-pipeline',
			],
			scope: 'product-area',
			summary:
				'When a PR introduces a new query shape (new filter columns, JSONB path filter, or correlated subquery), the supporting index ships in the same PR. Author pre-flight: "what does this query plan look like at 50k rows?" Three shapes seen in 2026-05: (1) JSONB `->>` filters need a partial expression index gated by a JSONB existence predicate; (2) new `(workspace_id, Y)` filters aren\'t covered by existing `(workspace_id, X)`; (3) correlated subqueries usually want a rewrite, not an index.',
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'p06-fix-category-mix-queue',
		title:
			"Code Reviewer's fix-category mix tracks the PR queue's domain mix — a11y emerges only when the queue is UI-heavy",
		body: '## Rule\n\nCode Reviewer\'s mix of fix categories is a function of the PR queue\'s domain mix, not a fixed taxonomy. When the queue shifts toward UI-heavy diffs, accessibility findings (aria-live chattiness, screen-reader labeling semantics, touch-input reachability) surface as a new category — even though they were absent when backend-heavy diffs dominated. The category emergence is *caused by* the queue composition, not by a change in reviewer behavior.\n\n## Why this matters\n\n- **Checklist evolution should be queue-driven.** Adding "check a11y" to the `review-checklist` skill before the queue actually produces a11y diffs creates noise. Adding it after the category surfaces — and after findings escalate beyond NIT/SHOULD-debate level — keeps the checklist useful.\n- **A new category is not the same as a new failure mode.** 1 SHOULD + 2 NITs is an emerging-signal category, not a problem to gate on. The right action is "log and watch," not "add to checklist immediately."\n- **The pattern repeats across categories.** The same 48h sweep also surfaced a sibling pattern — 3 missing-DB-index SHOULDs on 2 of 16 PRs (insight `18d37699`). Both categories were absent before the queue shifted. The underlying mechanism — *category mix tracks queue mix* — is the durable rule; the specific categories that surface in any given sweep depend on what\'s flowing through.\n\n## How to apply\n\n- **Pre-flight checklist changes:** don\'t add a11y as a standalone item until findings cross the SHOULD threshold sustainably (concrete screen-reader/touch failures, not labeling debates) over multiple sweeps. One 48h window with 1 SHOULD + 2 NITs is below the bar.\n- **Reading future `code-review-pattern` insights:** expect the category mix to track queue mix. If the queue shifts backend-heavy again, expect a11y to fade and DB-index / migration / route-handler categories to rise. Don\'t read "a11y disappeared" as "the reviewer regressed" — read it as "the diffs stopped containing the surface area."\n- **Watching for escalation:** two cheap signals — (a) whether Magnus internalizes the `aria-live` SHOULD in subsequent comment-input changes (confirms feedback is landing); (b) whether any a11y finding crosses from "labeling debate" to "concrete failure" within ~7 days of this sweep (escalates the category from emerging to actionable).\n\n## Confidence and limits\n\nMedium confidence. The 48h sample is small (3 findings), but the causal hypothesis is grounded in a separately observed queue-shift that documents the queue is now 100% magnusnoeddegaard UI-heavy work.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'provenance:writer',
				'code-review-pattern',
				'review-checklist',
				'accessibility',
				'a11y',
				'queue-composition',
				'emerging-category',
				'magnus-pr-profile',
				'topic:agent-pipeline',
			],
			scope: 'workspace',
			summary:
				"Code Reviewer's fix-category mix is a function of the PR queue's domain mix, not a fixed taxonomy. When the queue shifts UI-heavy, a11y findings (aria-live chattiness, screen-reader labeling, touch reachability) surface as a new category — absent when backend-heavy work dominated. Category mix tracks queue mix; the same sweep also surfaced a parallel DB-index category. Don't add a11y to the checklist until findings cross the SHOULD threshold sustainably — one 48h sample is below the bar.",
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'p07-react-identity-stability',
		title:
			'React identity-stability: parent re-renders churn child `useMemo` caches when inline arrays/handlers are passed as deps',
		body: "## Rule\n\nWhen a parent component passes **inline literal arrays, inline arrow functions, or inline object literals** as props into a child that uses those props as `useMemo` / `useCallback` / `useReactTable` dependencies, the child's memoised value rebuilds on **every parent render** — not on actual data change. The cache is structurally defeated. The fix lives in the parent: stabilise the references before they cross the prop boundary.\n\nThis is a performance-hygiene class, not a correctness class. The Code Reviewer surfaces it as a SHOULD finding (confidence ~6/10), non-blocking, framed as \"wasted CPU, not a functional bug.\"\n\n## The architectural shape to recognise\n\n```tsx\n// PARENT — every render produces new identities for `actors ?? []` and the arrow\n<RelatedObjectsTable\n  actors={actors ?? []}\n  onDeleteRelationship={(id) => deleteRelationship.mutate(id)}\n/>\n\n// CHILD — memo cache key depends on those identities\nconst columns = useMemo(\n  () => buildColumns(workspaceId, actors, onDeleteRelationship),\n  [workspaceId, actors, onDeleteRelationship],\n);\n```\n\nThree triggers, all reduce to the same root cause — a new JS value is allocated in the parent's render body:\n\n1. **Fallback literals at the prop site** — `prop ?? []`, `prop ?? {}`, `prop ?? defaultValue` allocate a new array/object every render while `prop` is undefined (typically the react-query loading window).\n2. **Inline arrow handlers** — `onX={(id) => mutate(id)}` is a new function identity every render.\n3. **Inline object literals** — `style={{ ... }}`, `config={{ ... }}`, etc.\n\nThe child's `useMemo` then either rebuilds an expensive structure (columns array, derived map) or cascades into deeper memos that also bust.\n\n## Fix recipes\n\n- **Stabilise the fallback**: hoist `const EMPTY: T[] = []` to module scope, or wrap in `useMemo(() => prop ?? [], [prop])` in the parent. The module-scope sentinel is preferred — zero hook cost, single global identity.\n- **Wrap mutate / callback handlers in `useCallback`** with the mutation hook in the dep list (`deleteRelationship.mutate` is stable across renders for react-query, so the dep array is just `[deleteRelationship]` or `[]` if you reach in via the closure).\n- **Lift per-row work up the tree** when a `useMemo` runs inside a child rendered N times — build the derived value once in the parent (or via a small context provider) and pass the result down.\n\n## Where to look first when triaging a PR\n\n- Any new component that calls `useReactTable`, `useMemo` over `columns`, or `useCallback` over a row-action handler — walk one level up and inspect the call site for inline literals.\n- Per-row components inside a feed/list that contain their own `useMemo` building a `Map`, `Set`, or `Record` from props — that work almost always wants to be lifted.\n- Components consuming `react-query` data with a `?? defaultValue` at the prop boundary — the loading→loaded transition will churn the child's memo cache twice (undefined → fallback → real data).",
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: [
				'code-review-pattern',
				'react',
				'memoization',
				'identity-stability',
				'performance',
				'frontend',
				'useMemo',
				'useCallback',
				'magnus-pr-profile',
				'topic:agent-pipeline',
			],
			scope: 'product-area',
			summary:
				"When a React parent passes inline literals — fallback arrays (`prop ?? []`), arrow handlers, or object literals — into a child using those props as `useMemo`/`useCallback`/`useReactTable` deps, the child's memo rebuilds every parent render. Cache is structurally defeated. Fix in the parent: hoist a module-scope EMPTY sentinel (or memoise the fallback), wrap inline handlers in `useCallback`, and lift per-row `useMemo` work up to the list parent. CR flags this as a SHOULD, non-blocking.",
			confidence: 'medium',
		},
	},
]

// One eval pair per pilot row, in the same order. Each excerpt appears in
// the gold row's title or body (module-level self-check enforces). Same
// grading contract T4/T8 use — substring, whitespace- and case-insensitive.
export const PILOT_PAIRS: readonly RepresentativePair[] = [
	{
		question:
			'What defines membership for the agent-pipeline knowledge index — how does the router know which articles belong under this catalog?',
		expectedFixtureId: 'p01-index-agent-pipeline',
		expectedExcerpt: 'Membership rule',
	},
	{
		question:
			'A telemetry surface (stdout log line or PostHog event) is about to ship a raw meeting URL alongside the payload — what is the observability guidance on shaping that payload?',
		expectedFixtureId: 'p02-telemetry-payload-trim',
		expectedExcerpt: 'trim the payload to the minimal field',
	},
	{
		question:
			'Inside a webhook handler that must ack within a few seconds, is it safe to serially await a long fan-out of file downloads before responding — and if not, what is the fix pattern?',
		expectedFixtureId: 'p03-hot-path-async-safety',
		expectedExcerpt: 'ack first, then do work',
	},
	{
		question:
			'The diff on this PR is mechanically clean but it reverses a workspace policy the team previously ratified. What is the Code Reviewer expected to do?',
		expectedFixtureId: 'p04-cr-bet-level-scope-expansion',
		expectedExcerpt: 'refuse approval',
	},
	{
		question:
			'A route adds a new WHERE clause on `(workspace_id, entity_id)` but the only existing composite is `(workspace_id, created_at)` — does that existing index cover the new query, and why or why not?',
		expectedFixtureId: 'p05-ship-db-index-with-query',
		expectedExcerpt: 'no usable prefix',
	},
	{
		question:
			'One 48-hour window produced 1 SHOULD and 2 NITs on accessibility findings. Should we add a11y as a standalone item to the review checklist based on this sample?',
		expectedFixtureId: 'p06-fix-category-mix-queue',
		expectedExcerpt: 'below the bar',
	},
	{
		question:
			'A parent React component passes `actors ?? []` and inline arrow handlers into a child that memoises its columns on those props. What is the underlying failure mode?',
		expectedFixtureId: 'p07-react-identity-stability',
		expectedExcerpt: 'structurally defeated',
	},
]

if (PILOT_CORPUS.length !== 7) {
	throw new Error(`PILOT_CORPUS must have 7 entries (has ${PILOT_CORPUS.length}).`)
}

if (PILOT_PAIRS.length !== 7) {
	throw new Error(`PILOT_PAIRS must have 7 entries (has ${PILOT_PAIRS.length}).`)
}

const PILOT_IDS = new Set(PILOT_CORPUS.map((row) => row.fixtureId))
if (PILOT_IDS.size !== PILOT_CORPUS.length) {
	throw new Error('PILOT_CORPUS fixtureIds must be unique.')
}
for (const pair of PILOT_PAIRS) {
	if (!PILOT_IDS.has(pair.expectedFixtureId)) {
		throw new Error(
			`PILOT_PAIRS references fixtureId ${pair.expectedFixtureId} which is not in PILOT_CORPUS.`,
		)
	}
}

// Excerpt must be present in title or body of its gold row — otherwise the
// grader can never score the pair correct and the harness silently biases
// low. Same check the T8 representative fixture runs.
const PILOT_BY_ID = new Map(PILOT_CORPUS.map((row) => [row.fixtureId, row]))
const normalisePilot = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
for (const pair of PILOT_PAIRS) {
	const row = PILOT_BY_ID.get(pair.expectedFixtureId)
	if (!row) continue
	const source = normalisePilot(`${row.title}\n${row.body}`)
	if (!source.includes(normalisePilot(pair.expectedExcerpt))) {
		throw new Error(
			`PILOT_PAIRS excerpt not found in gold row: ${pair.expectedFixtureId} :: ${pair.expectedExcerpt}`,
		)
	}
}

// Every pilot row must be v1 — the router filters on
// `metadata.format_version === 'v1'`. A non-v1 row would silently drop
// out of the router leg without any retrieval-accuracy explanation.
for (const row of PILOT_CORPUS) {
	if (row.metadata.format_version !== 'v1') {
		throw new Error(
			`PILOT_CORPUS row ${row.fixtureId} missing format_version=v1 — router leg would drop it silently.`,
		)
	}
}
