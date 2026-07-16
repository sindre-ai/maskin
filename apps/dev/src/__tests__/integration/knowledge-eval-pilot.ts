/**
 * T9 pilot corpus — the seven agent-pipeline knowledge nodes the
 * measurement gate scores against. Six upgraded-in-place playbook /
 * operational articles plus one layer-3 index (see bet comment
 * https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/9a589a23-4aaa-43c7-a872-a503efc91c1e#comment-288182).
 *
 * Article bodies and metadata are snapshotted verbatim from the maskin
 * knowledge nodes on 2026-07-16. Each `expectedExcerpt` is a passage from
 * the corresponding article's body — exact-substring grader catches the
 * verbatim-quote case; semantic-match grader (T-follow-up) catches the
 * paraphrase case.
 *
 * Shape matches `knowledge-eval-representative.ts` on purpose — the
 * paired runner and router adapter are agnostic to which corpus they run
 * against, so a pilot artifact can be produced by pointing the same
 * runner at this fixture.
 */

import type { RepresentativeArticle, RepresentativePair } from './knowledge-eval-representative'

// Pilot rows live in maskin (not in git), so there is no source commit to
// pin. The set is stable — validated + v1 — until T9 authors additional
// pilot rows, at which point this fixture is regenerated.
export const PILOT_SEED = 'maskin://fe944fe6-7b45-478c-afc7-b889cea63c08/pilot:t9-v1'
export const PILOT_SNAPSHOT_AT = '2026-07-16'

export const PILOT_CORPUS: readonly RepresentativeArticle[] = [
	{
		fixtureId: '544a5c4e-cf18-46a6-8aac-5837da1bc761',
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
		fixtureId: '81948ac6-3db4-42a0-bc04-901a70eec23b',
		title: 'Code-review pattern: telemetry surfaces leak more data than the signal requires',
		body: '## Conclusion\n\nWhen adding a log line, analytics event, or trace span, trim the payload to the minimal field that supports the metric. Shipping the raw input — meeting URLs, comment bodies, request payloads — into stdout logs, PostHog, or similar surfaces is a recurring SHOULD-flag in code review. The data is rarely needed for the question the instrumentation is supposed to answer, and the surface (log aggregator, product analytics) is a wider blast radius than the originating endpoint.\n\nTreat "what\'s the minimum I need to compute this signal?" as a required step when wiring telemetry, the same way you\'d treat input validation at a trust boundary.\n\n## The check to apply before merging telemetry changes\n\nFor every new log line / analytics event / trace attribute, answer two questions:\n\n- **What question is this signal answering?** (e.g. "do users post multi-line comments?", "which platform is the bot for?")\n- **What is the minimal value that answers it?** (boolean, enum, count, id — not the raw input)\n\nIf the field being shipped is wider than the answer (a URL where a platform enum suffices, a comment body where a `has_newline` boolean suffices), trim it. Bearer-style identifiers — meeting URLs, signed S3 URLs, share links, magic-link tokens — never go into logs or analytics. PII-bearing free text (comment bodies, message contents, names, emails) gets derived into a categorical before it\'s emitted.',
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
				'When wiring telemetry (logs, PostHog events, traces), trim the payload to the minimal value that supports the signal. Recurring code-review SHOULD-flag in June 2026: bearer-style meeting URLs in stdout logs and raw comment bodies in PostHog events — both fixable by emitting an id, enum, or derived boolean instead of the raw input.',
			confidence: 'medium',
		},
	},
	{
		fixtureId: '09dc15a8-b8c6-4c68-8bb7-c619864e9647',
		title:
			'Hot-path async safety: account for caller timeout budgets and worst-case retry semantics',
		body: "## Conclusion\n\nWhen wiring a slow operation into a fast-return caller (webhook ack, user-facing redirect, optimistic UI), the Developer agent must explicitly reason about the caller's timeout budget and worst-case retry semantics — not just the happy path. `await` inside a latency-sensitive path is a code smell until proven safe.\n\n## Fixes by shape\n\n- **Fan-out in a fast-ack path:** ack first, then do work — or `Promise.allSettled` if the budget allows. Never serial `await` in a loop.\n- **Best-effort side-effects:** `void fn().catch(log)` — don't await, but capture errors.\n- **Optimistic mutation of N items:** track per-id state and roll back on per-id `onError`/`onSuccess`, not bulk `onSettled`.\n\n## Heuristic for review and authoring\n\nBefore adding `await` inside a request handler, webhook, or UI mutation, answer:\n1. What is the caller's timeout / ack deadline?\n2. What does the caller do on timeout — retry, fail, both?\n3. If retried, is this operation idempotent?\n\nIf any answer is unknown or unfavorable, move the work off the hot path or fire-and-forget with error capture.",
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
		fixtureId: '7c23eaf4-7d48-47c9-aa34-1acc5653d7d6',
		title:
			"Code Reviewer's review surface has expanded from diff-level to bet-level: provenance and policy-reversal are now gating concerns",
		body: "## Rule\n\nThe Code Reviewer has begun issuing BLOCK verdicts on **bet-level / governance-level** grounds — not on code defects. As of 2026-05-21 (PR #442 \"fix(mcp): re-enable notification tools\"), CR will refuse approval if:\n\n1. The **originating insight** for the bet was previously **discarded** by Insight Triage (e.g. flagged as a suspected prompt-injection signal) and the discard was never reconciled.\n2. The PR **reverses a previously-ratified workspace policy** without a corresponding human-authored signal that the policy has changed.\n\nThe verdict on PR #442 was BLOCK despite the diff being mechanically clean (0 MUST / 0 SHOULD / 0 NIT on code quality). The block was on the *premise of the work*, not the work itself.\n\n## How to apply\n\n- **Treat bet-level gating as a feature, not noise.** Don't suppress it by narrowing CR's context. If anything, the implementer-task review should also pull upstream context (originating insight status, policy-reversal check).\n- **Don't auto-create bets off discarded insights.** The auto-bug pipeline should respect Insight Triage's `discarded` status — at minimum, refuse to advance without re-triage or human reconciliation.\n- **Make policy reversals an explicit signal.** PRs that touch files implementing a ratified workspace policy should require a corresponding policy-change signal in the bet or in CLAUDE.md before CR considers approval.",
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
				'topic:agent-pipeline',
			],
			scope: 'workspace',
			summary:
				'Code Reviewer began issuing BLOCK verdicts on bet-level grounds — not code defects — as of 2026-05-21 (PR #442). Two triggers: (1) originating insight was discarded (prompt-injection) and never reconciled, (2) PR reverses a ratified workspace policy without a change signal.',
			confidence: 'medium',
		},
	},
	{
		fixtureId: '3062b2c9-e157-42ee-a250-3ecbfca01867',
		title:
			'Ship the index in the same PR as the query: missing-DB-index is an emerging Code Reviewer SHOULD category (JSONB filter, composite, correlated subquery)',
		body: '## Rule\n\nWhen a PR introduces a **new query shape** in a route — a new filter column combination, a JSONB path filter, or a join/subquery pattern not previously exercised — the **supporting index ships in the same PR**. The pre-flight question for the author (not just the reviewer) is: *"what does this query plan look like at 50k rows?"*\n\nThe Code Reviewer now catches this class as a SHOULD finding (confidence 6–7/10), non-blocking on the merge SHA but flagged because it is the cohort of issues most likely to surface as a **production incident after merge**, when the workspace has scaled past the dev-fixture dataset.\n\n## The three shapes to recognise\n\n### 1. JSONB path filter with no supporting expression index\n\n**Fix recipe:** partial expression index, guarded by a JSONB existence predicate so it stays tight.\n\n### 2. New filter column combination missing a composite index\n\n**Fix recipe:** composite index matching the new filter prefix, and the ORDER BY if it can ride the same index. The trap: an existing `(workspace_id, X)` index does **not** cover a new `(workspace_id, Y)` filter.\n\n### 3. Correlated subquery that scales O(N × M)\n\nAcceptable for v1 with bounded inputs; flagged for revisit when the feature goes workspace-wide. The architectural fix is usually a rewrite to a single join or a denormalised counter, not an index.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: [
				'provenance:writer',
				'code-review-pattern',
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
				"When a PR introduces a new query shape (new filter columns, JSONB path filter, or correlated subquery), the supporting index ships in the same PR. Author pre-flight: 'what does this query plan look like at 50k rows?'",
			confidence: 'medium',
		},
	},
	{
		fixtureId: '9a02894c-3934-49e3-9ee4-1a2edcf29b09',
		title:
			"Code Reviewer's fix-category mix tracks the PR queue's domain mix — a11y emerges only when the queue is UI-heavy",
		body: '## Rule\n\nCode Reviewer\'s mix of fix categories is a function of the PR queue\'s domain mix, not a fixed taxonomy. When the queue shifts toward UI-heavy diffs, accessibility findings (aria-live chattiness, screen-reader labeling semantics, touch-input reachability) surface as a new category — even though they were absent when backend-heavy diffs dominated. The category emergence is *caused by* the queue composition, not by a change in reviewer behavior.\n\n## Why this matters\n\n- **Checklist evolution should be queue-driven.** Adding "check a11y" to the `review-checklist` skill before the queue actually produces a11y diffs creates noise. Adding it after the category surfaces — and after findings escalate beyond NIT/SHOULD-debate level — keeps the checklist useful.\n- **A new category is not the same as a new failure mode.** 1 SHOULD + 2 NITs is an emerging-signal category, not a problem to gate on.\n- **The pattern repeats across categories.** The same 48h sweep also surfaced a sibling pattern — 3 missing-DB-index SHOULDs on 2 of 16 PRs. Both categories were absent before the queue shifted.',
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
				'topic:agent-pipeline',
			],
			scope: 'workspace',
			summary:
				"Code Reviewer's fix-category mix is a function of the PR queue's domain mix, not a fixed taxonomy. When the queue shifts UI-heavy, a11y findings surface as a new category — absent when backend-heavy work dominated.",
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'd3816268-5137-4969-af88-d8679d7313f6',
		title:
			'React identity-stability: parent re-renders churn child `useMemo` caches when inline arrays/handlers are passed as deps',
		body: '## Rule\n\nWhen a parent component passes **inline literal arrays, inline arrow functions, or inline object literals** as props into a child that uses those props as `useMemo` / `useCallback` / `useReactTable` dependencies, the child\'s memoised value rebuilds on **every parent render** — not on actual data change. The cache is structurally defeated. The fix lives in the parent: stabilise the references before they cross the prop boundary.\n\nThis is a performance-hygiene class, not a correctness class. The Code Reviewer surfaces it as a SHOULD finding (confidence ~6/10), non-blocking, framed as "wasted CPU, not a functional bug."\n\n## Fix recipes\n\n- **Stabilise the fallback**: hoist `const EMPTY: T[] = []` to module scope, or wrap in `useMemo(() => prop ?? [], [prop])` in the parent. The module-scope sentinel is preferred — zero hook cost, single global identity.\n- **Wrap mutate / callback handlers in `useCallback`** with the mutation hook in the dep list.\n- **Lift per-row work up the tree** when a `useMemo` runs inside a child rendered N times — build the derived value once in the parent (or via a small context provider) and pass the result down.',
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
				'topic:agent-pipeline',
			],
			scope: 'product-area',
			summary:
				"When a React parent passes inline literals — fallback arrays (`prop ?? []`), arrow handlers, or object literals — into a child using those props as `useMemo`/`useCallback` deps, the child's memo rebuilds every parent render. Cache is structurally defeated. Fix in the parent: hoist a module-scope EMPTY sentinel, wrap inline handlers in `useCallback`, and lift per-row `useMemo` work up to the list parent.",
			confidence: 'medium',
		},
	},
]

// One query per pilot row. Each `expectedExcerpt` appears verbatim in
// its article body — the exact-substring grader catches the case where
// the model quotes; the semantic-match grader catches the case where the
// model paraphrases (which is what the exact grader missed on the
// pre-live pilot run, dropping correctness to 4/7 in both regimes).
export const PILOT_PAIRS: readonly RepresentativePair[] = [
	{
		question: 'How does the agent-pipeline knowledge index decide what an agent should read next?',
		expectedFixtureId: '544a5c4e-cf18-46a6-8aac-5837da1bc761',
		expectedExcerpt:
			'Router reads the summary and the summaries of the six catalogued articles first, then pulls only the article bodies it decides it needs.',
	},
	{
		question: 'How should I size the payload of a new log line or PostHog event?',
		expectedFixtureId: '81948ac6-3db4-42a0-bc04-901a70eec23b',
		expectedExcerpt: 'trim the payload to the minimal field that supports the metric',
	},
	{
		question:
			'What must the Developer agent reason about before adding an await inside a webhook handler?',
		expectedFixtureId: '09dc15a8-b8c6-4c68-8bb7-c619864e9647',
		expectedExcerpt:
			"explicitly reason about the caller's timeout budget and worst-case retry semantics",
	},
	{
		question: 'On what bet-level ground will the Code Reviewer BLOCK a PR whose diff is clean?',
		expectedFixtureId: '7c23eaf4-7d48-47c9-aa34-1acc5653d7d6',
		expectedExcerpt: 'reverses a previously-ratified workspace policy',
	},
	{
		question: "What's the author-side pre-flight question when a PR adds a new query shape?",
		expectedFixtureId: '3062b2c9-e157-42ee-a250-3ecbfca01867',
		expectedExcerpt: 'what does this query plan look like at 50k rows?',
	},
	{
		question: 'Why do a11y findings appear in some Code Reviewer sweeps and not others?',
		expectedFixtureId: '9a02894c-3934-49e3-9ee4-1a2edcf29b09',
		expectedExcerpt:
			"Code Reviewer's mix of fix categories is a function of the PR queue's domain mix",
	},
	{
		question:
			"How does a parent prevent a child's useMemo cache from rebuilding on every parent render?",
		expectedFixtureId: 'd3816268-5137-4969-af88-d8679d7313f6',
		expectedExcerpt: 'stabilise the references before they cross the prop boundary',
	},
]

// Module-level self-check — mirrors the invariant enforced on the
// representative fixture. Runs at import time so a broken excerpt is
// caught before the test file loads it.
{
	const byId = new Map(PILOT_CORPUS.map((row) => [row.fixtureId, row]))
	const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
	for (const pair of PILOT_PAIRS) {
		const gold = byId.get(pair.expectedFixtureId)
		if (!gold) throw new Error(`pilot fixture: unknown expectedFixtureId ${pair.expectedFixtureId}`)
		const hay = normalise(`${gold.title}\n${gold.body}`)
		if (!hay.includes(normalise(pair.expectedExcerpt))) {
			throw new Error(
				`pilot fixture: excerpt for ${pair.expectedFixtureId} not found in title or body`,
			)
		}
	}
}
