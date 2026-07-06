/**
 * Per-type joint retrieval fixture — bet / task / insight pairs.
 *
 * Extends the knowledge-metadata bet's joint fixture with per-type miss
 * cases so the "let agents filter every object type by trust, currency, and
 * owner" bet can prove or disprove its central assumption: that missing
 * metadata filters — not text-match quality — cap today's cross-type
 * retrieval, and that the load-bearing fields differ per type.
 *
 * Sits alongside `knowledge-eval-fixture.ts` (the parent knowledge-metadata
 * bet's fixture) rather than modifying it — the knowledge subsets there
 * calibrate against `retrieveKnowledge()` (post-migration column-aware
 * path), which this diagnostic doesn't touch. Format matches the metadata
 * subset there so a Product Analyst can pool pairs into a joint eval when
 * the per-type sidecar tables ship.
 *
 * Shape per pair:
 *   - Expected row + one or more trap rows (all typed `bet`|`task`|`insight`).
 *   - Each row carries a hypothesised metadata field it depends on (e.g.
 *     `driver_id`, `verification_status`, `priority`) so the field candidate
 *     per type is legible from the fixture without running the eval.
 *   - The trap row is titled/worded so it outranks the expected row under
 *     the current `search_objects` path — either the whole-question ILIKE
 *     wall or the per-token ILIKE baseline used in `knowledge-eval.test.ts`.
 *   - `hypothesisedAttributable`: whether a miss on this pair should count
 *     as "would have been answered by adding the candidate metadata filter"
 *     when we do the after-the-fact classification.
 *
 * `customer` intentionally not included — deferred to T5 (the customer
 * sidecar) + the Product Analyst's full joint eval.
 */

export type WorkObjectType = 'bet' | 'task' | 'insight'

/**
 * The metadata dimensions this diagnostic ranges over. Chosen to line up
 * with the three axes named in the parent bet — trust (verification /
 * confidence / verdict), currency (recency / deployed_at / t_valid), and
 * owner (driver_id) — plus a per-type "shape" axis (priority for task,
 * promotion_mode for bet, source_type for insight).
 */
export type WorkFilterDimension =
	| 'driver'
	| 'recency'
	| 'status'
	| 'verdict'
	| 'promotion_mode'
	| 'priority'
	| 'review_state'
	| 'verification_status'
	| 'confidence'
	| 'source_type'
	| 'content_only'

export type WorkCorpusEntry = {
	fixtureId: string
	type: WorkObjectType
	title: string
	content: string
}

export type WorkEvalPair = {
	pairId: string
	type: WorkObjectType
	dimension: WorkFilterDimension
	question: string
	expectedFixtureIds: readonly string[]
	expectedExcerpt: string | null
	trapFixtureIds: readonly string[]
	/**
	 * The specific per-type sidecar field the parent bet would promote to a
	 * first-class column and expose as a `<field>_eq` filter on
	 * `search_objects`. Pairs whose dimension is `content_only` don't need a
	 * new field (baseline content search should already answer them) — those
	 * carry `null`.
	 */
	candidateField: string | null
	/**
	 * Hypothesis at write time: would adding the candidate metadata field as a
	 * filter turn a today-miss into a hit? `Y` = yes, this is a metadata-shaped
	 * question. `N` = no, this is a content-shaped question (any miss is a
	 * text-match problem, not a metadata problem).
	 */
	hypothesisedAttributable: 'Y' | 'N'
}

// ────────────────────────────────────────────────────────────────────────────
// bet · 10 pairs
// ────────────────────────────────────────────────────────────────────────────

const BET_CORPUS: readonly WorkCorpusEntry[] = [
	// B1 · driver — expected row has the answer but is out-ranked by a trap that
	// shares more question tokens under ILIKE.
	{
		fixtureId: 'w-b1-expected-mine-active',
		type: 'bet',
		title: 'Trim MCP tool responses across all providers',
		content:
			'Bet: cut MCP payload waste to lift context-window headroom on Developer and Reviewer agents.',
	},
	{
		fixtureId: 'w-b1-trap-current-active-bets',
		type: 'bet',
		title: 'Current active bets — portfolio snapshot for the week',
		content:
			'Snapshot of every currently active bet across the portfolio: what my bets, active bets, my active bets, and open bets look like now.',
	},

	// B2 · recency — "recently deployed" bets. Trap outranks with the word
	// "deployed" and "shipped" densely repeated.
	{
		fixtureId: 'w-b2-expected-agent-cost-reduction',
		type: 'bet',
		title: 'Cut Developer agent token waste',
		content:
			'Bet aiming for a ~50% cut in Developer-agent cost via MCP tool-registry dedup, skill lazy-load, baked pnpm in agent-base.',
	},
	{
		fixtureId: 'w-b2-trap-shipped-recently',
		type: 'bet',
		title: 'Bets shipped recently — deployment log of every recently deployed bet',
		content:
			'Every recently deployed bet is logged here. Recently shipped bets, deployed recently, recently deployed feature rollouts.',
	},

	// B3 · verdict — "passed" bets last month. Trap outranks with "passed",
	// "verdict", "won", but has no verdict field set.
	{
		fixtureId: 'w-b3-expected-shipped-cursor',
		type: 'bet',
		title: 'Ship Cursor integration for shared MCP profile',
		content:
			'Bet: ship the Cursor MCP integration with the shared 18-tool profile. Landed and validated the profile ceiling.',
	},
	{
		fixtureId: 'w-b3-trap-passed-verdict-summary',
		type: 'bet',
		title: 'Verdict digest — bets that passed their measurement window last month',
		content:
			'Passed bets last month, verdict summary, bets that passed their kill-triggers, passed criteria digest.',
	},

	// B4 · promotion_mode — proposed vs live. Trap contains "proposed" densely
	// but is itself a live bet.
	{
		fixtureId: 'w-b4-expected-proposed-agent-sim',
		type: 'bet',
		title: 'Agent-sim harness for staged bet rollout',
		content: 'Bet proposal: build an agent-sim harness before promoting bets from draft to live.',
	},
	{
		fixtureId: 'w-b4-trap-proposed-thinking-doc',
		type: 'bet',
		title: 'Proposed bets — thinking-out-loud doc of every proposed bet this cycle',
		content:
			'This week we proposed several bets. Proposed bet framing. Proposed and considered. Proposed bet list.',
	},

	// B5 · content-only control — question hits expected on content vocab
	// directly; should baseline-hit today.
	{
		fixtureId: 'w-b5-expected-branching-shared',
		type: 'bet',
		title: 'Shared-branch mode: one bet branch, many task PRs, one umbrella PR to main',
		content:
			'Bet: adopt shared-branch mode. Every code bet gets one branch; task PRs target that branch; a single umbrella PR ships to main.',
	},

	// B6 · driver — "bets Sindre owns". Trap outranks with driver name in the
	// title/content of an unrelated bet.
	{
		fixtureId: 'w-b6-expected-driver-sindre-bets-council',
		type: 'bet',
		title: 'Bet Council chip UI on the objects overview row',
		content: 'Bet: surface Bet Council state as a chip on the objects overview row.',
	},
	{
		fixtureId: 'w-b6-trap-sindre-mention-elsewhere',
		type: 'bet',
		title: 'Sindre wrote — recap of Sindre-authored bets and threads',
		content:
			'A recap of things Sindre wrote about, Sindre-driven bets, bets Sindre owns as a founder writer.',
	},

	// B7 · recency (review_date closed) — "bets past their review window".
	// Trap outranks with "review" and "expired".
	{
		fixtureId: 'w-b7-expected-review-window-closed-a',
		type: 'bet',
		title: 'Fix agent cost telemetry emitter',
		content: 'Bet running past its measurement window without a recorded evidence-backed verdict.',
	},
	{
		fixtureId: 'w-b7-trap-review-hygiene',
		type: 'bet',
		title: 'Review hygiene — bets whose review window expired without a verdict',
		content:
			'Review hygiene: bets past review, expired review windows, review overdue, review window closed.',
	},

	// B8 · content-only control — anchor-tagged bet question. Should baseline-hit.
	{
		fixtureId: 'w-b8-expected-anchor-3-decision-shipped',
		type: 'bet',
		title: 'Anchor #3 — decision to shipped reality',
		content:
			'Bet under anchor #3: close the gap between decision-recorded state and shipped-reality state.',
	},

	// B9 · confidence — "high-confidence bets". Trap contains "high confidence"
	// as an adjective phrase but points to a different bet.
	{
		fixtureId: 'w-b9-expected-confident-column-move',
		type: 'bet',
		title: 'Promote knowledge metadata to first-class columns',
		content: 'Bet with strong confidence signal from the failed knowledge-extension retro.',
	},
	{
		fixtureId: 'w-b9-trap-confidence-in-title',
		type: 'bet',
		title: 'High-confidence bets — the portfolio subset agents should prioritise',
		content:
			'High-confidence bets from the current portfolio. Confidence high, confidence marked high, high-confidence framing.',
	},

	// B10 · status — "which bets are still live" — trap outranks with "live"
	// in title but is itself in an earlier state.
	{
		fixtureId: 'w-b10-expected-live-search-fixture',
		type: 'bet',
		title: 'Baseline the joint retrieval fixture against today',
		content:
			'Bet is live and running the joint fixture through the current search_objects baseline.',
	},
	{
		fixtureId: 'w-b10-trap-live-in-title',
		type: 'bet',
		title: 'Bets going live — cycle rollout tracker for live bets',
		content:
			'Live bets, going live, live-only surface. Cycle tracker for bets that just went live.',
	},
]

const BET_PAIRS: readonly WorkEvalPair[] = [
	{
		pairId: 'B1',
		type: 'bet',
		dimension: 'driver',
		question: "What's currently on my plate — which of my active bets should I open first?",
		expectedFixtureIds: ['w-b1-expected-mine-active'],
		expectedExcerpt: 'MCP payload waste',
		trapFixtureIds: ['w-b1-trap-current-active-bets'],
		candidateField: 'driver_id',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B2',
		type: 'bet',
		dimension: 'recency',
		question: 'Which bets deployed to production in the last two weeks?',
		expectedFixtureIds: ['w-b2-expected-agent-cost-reduction'],
		expectedExcerpt: 'Developer-agent cost',
		trapFixtureIds: ['w-b2-trap-shipped-recently'],
		candidateField: 'deployed_at',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B3',
		type: 'bet',
		dimension: 'verdict',
		question: 'Show me every bet that passed its measurement window last month',
		expectedFixtureIds: ['w-b3-expected-shipped-cursor'],
		expectedExcerpt: 'Cursor MCP integration',
		trapFixtureIds: ['w-b3-trap-passed-verdict-summary'],
		candidateField: 'verdict',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B4',
		type: 'bet',
		dimension: 'promotion_mode',
		question: 'List the proposed bets — the ones not yet promoted to live',
		expectedFixtureIds: ['w-b4-expected-proposed-agent-sim'],
		expectedExcerpt: 'agent-sim harness',
		trapFixtureIds: ['w-b4-trap-proposed-thinking-doc'],
		candidateField: 'promotion_mode',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B5',
		type: 'bet',
		dimension: 'content_only',
		question: 'How do we run a shared branch for a code bet with multiple task PRs?',
		expectedFixtureIds: ['w-b5-expected-branching-shared'],
		expectedExcerpt: 'shared-branch mode',
		trapFixtureIds: [],
		candidateField: null,
		hypothesisedAttributable: 'N',
	},
	{
		pairId: 'B6',
		type: 'bet',
		dimension: 'driver',
		question: 'Which bets does Sindre currently drive?',
		expectedFixtureIds: ['w-b6-expected-driver-sindre-bets-council'],
		expectedExcerpt: 'Bet Council',
		trapFixtureIds: ['w-b6-trap-sindre-mention-elsewhere'],
		candidateField: 'driver_id',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B7',
		type: 'bet',
		dimension: 'recency',
		question: 'Which bets are past their review window and have no verdict yet?',
		expectedFixtureIds: ['w-b7-expected-review-window-closed-a'],
		expectedExcerpt: 'evidence-backed verdict',
		trapFixtureIds: ['w-b7-trap-review-hygiene'],
		candidateField: 'review_date',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B8',
		type: 'bet',
		dimension: 'content_only',
		question: 'Where do we track anchor #3 — decision to shipped reality — as a strategic anchor?',
		expectedFixtureIds: ['w-b8-expected-anchor-3-decision-shipped'],
		expectedExcerpt: 'decision-recorded state',
		trapFixtureIds: [],
		candidateField: null,
		hypothesisedAttributable: 'N',
	},
	{
		pairId: 'B9',
		type: 'bet',
		dimension: 'confidence',
		question: 'Give me the high-confidence bets I should focus on this week',
		expectedFixtureIds: ['w-b9-expected-confident-column-move'],
		expectedExcerpt: 'knowledge-extension retro',
		trapFixtureIds: ['w-b9-trap-confidence-in-title'],
		candidateField: 'confidence',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'B10',
		type: 'bet',
		dimension: 'status',
		question: 'Which bets are still live right now?',
		expectedFixtureIds: ['w-b10-expected-live-search-fixture'],
		expectedExcerpt: 'joint fixture',
		trapFixtureIds: ['w-b10-trap-live-in-title'],
		candidateField: 'status',
		hypothesisedAttributable: 'Y',
	},
]

// ────────────────────────────────────────────────────────────────────────────
// task · 10 pairs
// ────────────────────────────────────────────────────────────────────────────

const TASK_CORPUS: readonly WorkCorpusEntry[] = [
	// T1 · driver — "my queue" question, trap outranks with "queue" in the title.
	{
		fixtureId: 'w-t1-expected-my-queue-real-task',
		type: 'task',
		title: 'Wire fallback push in the driver-handoff skill',
		content: 'Task on my queue this week. Assigned to me, still open.',
	},
	{
		fixtureId: 'w-t1-trap-queue-explainer',
		type: 'task',
		title: "Explainer — how the my-queue view builds the driver's queue",
		content:
			'The queue view — my queue, driver queue, personal queue. Queue mechanics explainer for the queue.',
	},

	// T2 · status — "in_review tasks". Trap outranks with "review" repeated in
	// title/content but is in a different status.
	{
		fixtureId: 'w-t2-expected-in-review-a11y',
		type: 'task',
		title: 'Add accessibility snapshot to StatusBadge',
		content: 'Task is currently in review; awaiting reviewer sign-off before merge.',
	},
	{
		fixtureId: 'w-t2-trap-in-review-lots',
		type: 'task',
		title: 'Review notes — a running review of what to review next',
		content: 'Review, review, review. In-review review workflow notes. Review checklist review.',
	},

	// T3 · priority — "P0 tasks right now". Trap contains "P0" in a general
	// discussion but is not a P0 task itself.
	{
		fixtureId: 'w-t3-expected-p0-outage-fix',
		type: 'task',
		title: 'Fix session-log 8KB PG NOTIFY payload rollback',
		content: 'Task marked P0 by the on-call rotation after the outage postmortem.',
	},
	{
		fixtureId: 'w-t3-trap-p0-vocabulary',
		type: 'task',
		title: 'P0 vs P1 vs P2 — how we tag task priority',
		content:
			'Priority tags: P0, P1, P2, P3. P0 tasks are the top priority. P0 label meaning. P0 conventions.',
	},

	// T4 · recency — "tasks touched today". Trap outranks with dates in title
	// but is a stale task.
	{
		fixtureId: 'w-t4-expected-touched-today',
		type: 'task',
		title: 'Add unit test for parseTokenResponse variance',
		content: 'Task updated within the last hour — just pushed a fix.',
	},
	{
		fixtureId: 'w-t4-trap-recent-activity-doc',
		type: 'task',
		title: 'Recent-activity view — today, yesterday, this week, this hour',
		content:
			'Today, today, today, yesterday, this hour, this week, updated recently, touched recently.',
	},

	// T5 · review_state — "waiting for human review". Trap outranks with
	// "human review" phrase but is not in that state.
	{
		fixtureId: 'w-t5-expected-waiting-human',
		type: 'task',
		title: 'Wire slack-writer to task-review flow',
		content:
			'Task PR opened and reviewer @mentioned. Waiting on human sign-off before Code Reviewer merges.',
	},
	{
		fixtureId: 'w-t5-trap-human-review-doc',
		type: 'task',
		title: 'Human review vs agent review — when to escalate to a human reviewer',
		content:
			'Human review conventions. Human reviewer escalation. Human review flow overview. Human review escalation criteria.',
	},

	// T6 · content-only control — question uses the exact tag; baseline should
	// hit.
	{
		fixtureId: 'w-t6-expected-migrations-runner',
		type: 'task',
		title: 'Migrate CI runner from CircleCI to GitHub Actions',
		content:
			'Task migrates the CI runner from CircleCI to GitHub Actions and archives the old configs.',
	},

	// T7 · driver — "what's Bob's queue". Bob mentioned in a trap doc.
	{
		fixtureId: 'w-t7-expected-bob-queue-real-task',
		type: 'task',
		title: 'Land seaweedfs disk-quota alert threshold',
		content: "Task assigned to Bob. On Bob's queue this week.",
	},
	{
		fixtureId: 'w-t7-trap-bob-mention-doc',
		type: 'task',
		title: "Bob's onboarding — Bob is on-call for infra this week",
		content:
			'Bob wrote the on-call rotation. Bob covers infra this week. Bob mentions in the rotation doc. Bob rotation.',
	},

	// T8 · status — "closed vs open" — trap outranks with "closed" repeated
	// but is actually still open.
	{
		fixtureId: 'w-t8-expected-closed-recent',
		type: 'task',
		title: 'Add pagination metadata to list_objects hero-card',
		content: 'Task closed and shipped last week.',
	},
	{
		fixtureId: 'w-t8-trap-closed-terminology',
		type: 'task',
		title: 'Closed vs discarded vs archived — how we mark closed tasks',
		content:
			'Closed tasks, task closed, closed workflow, marking a task closed, closed state machine.',
	},

	// T9 · content-only control — a real content question. Should baseline-hit.
	{
		fixtureId: 'w-t9-expected-pg-notify-payload',
		type: 'task',
		title: 'Truncate pg_notify payload to stay under the 8KB limit',
		content:
			'Task: apply the truncate pattern from migration 0006 to the new session_logs trigger.',
	},

	// T10 · recency — "tasks not touched in 30+ days" — trap outranks with
	// "stale" phrases but was updated recently.
	{
		fixtureId: 'w-t10-expected-stale-real',
		type: 'task',
		title: 'Backfill trigger-name column on the events table',
		content: 'Task last touched 45 days ago. No activity since. Nobody picked it up.',
	},
	{
		fixtureId: 'w-t10-trap-stale-doc',
		type: 'task',
		title: 'Stale-task sweeper — bumps tasks not touched in 30 days',
		content:
			'Stale tasks, staleness threshold, stale-task sweeper, sweep stale tasks, 30-day staleness.',
	},
]

const TASK_PAIRS: readonly WorkEvalPair[] = [
	{
		pairId: 'T1',
		type: 'task',
		dimension: 'driver',
		question: "What's on my queue this week — the tasks assigned to me?",
		expectedFixtureIds: ['w-t1-expected-my-queue-real-task'],
		expectedExcerpt: 'driver-handoff skill',
		trapFixtureIds: ['w-t1-trap-queue-explainer'],
		candidateField: 'driver_id',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T2',
		type: 'task',
		dimension: 'status',
		question: 'Which tasks are currently in review?',
		expectedFixtureIds: ['w-t2-expected-in-review-a11y'],
		expectedExcerpt: 'StatusBadge',
		trapFixtureIds: ['w-t2-trap-in-review-lots'],
		candidateField: 'status',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T3',
		type: 'task',
		dimension: 'priority',
		question: 'What P0 tasks are open right now?',
		expectedFixtureIds: ['w-t3-expected-p0-outage-fix'],
		expectedExcerpt: 'PG NOTIFY',
		trapFixtureIds: ['w-t3-trap-p0-vocabulary'],
		candidateField: 'priority',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T4',
		type: 'task',
		dimension: 'recency',
		question: 'Which tasks were touched today?',
		expectedFixtureIds: ['w-t4-expected-touched-today'],
		expectedExcerpt: 'parseTokenResponse',
		trapFixtureIds: ['w-t4-trap-recent-activity-doc'],
		candidateField: 'updated_at',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T5',
		type: 'task',
		dimension: 'review_state',
		question: 'Which tasks are waiting for a human reviewer?',
		expectedFixtureIds: ['w-t5-expected-waiting-human'],
		expectedExcerpt: 'slack-writer',
		trapFixtureIds: ['w-t5-trap-human-review-doc'],
		candidateField: 'review_state',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T6',
		type: 'task',
		dimension: 'content_only',
		question: 'What task is moving the CI runner from CircleCI to GitHub Actions?',
		expectedFixtureIds: ['w-t6-expected-migrations-runner'],
		expectedExcerpt: 'CircleCI to GitHub Actions',
		trapFixtureIds: [],
		candidateField: null,
		hypothesisedAttributable: 'N',
	},
	{
		pairId: 'T7',
		type: 'task',
		dimension: 'driver',
		question: "What is Bob currently working on — Bob's task queue?",
		expectedFixtureIds: ['w-t7-expected-bob-queue-real-task'],
		expectedExcerpt: 'seaweedfs disk-quota',
		trapFixtureIds: ['w-t7-trap-bob-mention-doc'],
		candidateField: 'driver_id',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T8',
		type: 'task',
		dimension: 'status',
		question: 'Which tasks are closed already versus still open?',
		expectedFixtureIds: ['w-t8-expected-closed-recent'],
		expectedExcerpt: 'hero-card',
		trapFixtureIds: ['w-t8-trap-closed-terminology'],
		candidateField: 'status',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'T9',
		type: 'task',
		dimension: 'content_only',
		question: 'Which task truncates the pg_notify payload to stay under the 8KB limit?',
		expectedFixtureIds: ['w-t9-expected-pg-notify-payload'],
		expectedExcerpt: '8KB limit',
		trapFixtureIds: [],
		candidateField: null,
		hypothesisedAttributable: 'N',
	},
	{
		pairId: 'T10',
		type: 'task',
		dimension: 'recency',
		question: "Which tasks haven't been touched in 30 days?",
		expectedFixtureIds: ['w-t10-expected-stale-real'],
		expectedExcerpt: 'trigger-name column',
		trapFixtureIds: ['w-t10-trap-stale-doc'],
		candidateField: 'updated_at',
		hypothesisedAttributable: 'Y',
	},
]

// ────────────────────────────────────────────────────────────────────────────
// insight · 10 pairs
// ────────────────────────────────────────────────────────────────────────────

const INSIGHT_CORPUS: readonly WorkCorpusEntry[] = [
	// I1 · verification_status — verified insights only. Trap outranks with
	// "verified" but is itself unverified.
	{
		fixtureId: 'w-i1-expected-verified-real',
		type: 'insight',
		title: 'Multi-source convergence as a ranking signal for agent content triage',
		content: 'Insight validated against three independent editorial sources.',
	},
	{
		fixtureId: 'w-i1-trap-verified-terminology',
		type: 'insight',
		title: 'Verified vs unverified vs contested — insight verification vocabulary',
		content:
			'Verification vocabulary. Verified insights, unverified insights, contested insights, verification state.',
	},

	// I2 · recency (t_valid) — "insights from this week". Trap outranks with
	// "this week" but is a stale insight.
	{
		fixtureId: 'w-i2-expected-fresh-real',
		type: 'insight',
		title: "Anthropic's Claude Tag generates 65% of product team code",
		content: 'Insight added this week from a 2026-07 external report.',
	},
	{
		fixtureId: 'w-i2-trap-fresh-terminology',
		type: 'insight',
		title: 'What we learned this week — insights this week, this week roundup',
		content:
			'This week: this week roundup. This week we learned. This week learnings. This week highlights this week.',
	},

	// I3 · source_type — "insights from PostHog". Trap outranks with "PostHog"
	// discussion but is not sourced from PostHog.
	{
		fixtureId: 'w-i3-expected-posthog-usage',
		type: 'insight',
		title: 'Developer-agent session_ended events under-emit exit_code=0',
		content: 'Insight sourced from a PostHog dashboard query on 2026-06-30.',
	},
	{
		fixtureId: 'w-i3-trap-posthog-mention',
		type: 'insight',
		title: 'PostHog integration surface — PostHog vs alternative analytics providers',
		content:
			'PostHog is our analytics store. PostHog query surface. PostHog dashboard. PostHog mention in the integration doc.',
	},

	// I4 · confidence — "high-confidence insights". Trap outranks with
	// "high confidence" in title but low actual confidence.
	{
		fixtureId: 'w-i4-expected-high-confidence-real',
		type: 'insight',
		title: "Agent-run public content sites are inside maskin's product surface",
		content:
			'Insight backed by an explicit founder positioning signal from Sebastian on 2026-06-30.',
	},
	{
		fixtureId: 'w-i4-trap-high-confidence-terminology',
		type: 'insight',
		title: 'High vs medium vs low — insight confidence marking',
		content:
			'High confidence, high-confidence insights, confidence marking, low confidence, medium confidence.',
	},

	// I5 · driver — "insights I filed". Trap outranks with driver name in
	// content of another insight.
	{
		fixtureId: 'w-i5-expected-driver-real',
		type: 'insight',
		title: 'Kill triggers only count when the eval stresses the mechanism the bet promises',
		content: 'Insight filed by Sindre after the failed Knowledge Extension bet retro.',
	},
	{
		fixtureId: 'w-i5-trap-driver-mention',
		type: 'insight',
		title: 'Sindre — recap of Sindre-authored insights across cycles',
		content:
			'Sindre wrote several insights. Sindre insights, insights Sindre filed, Sindre driver, Sindre-driven notes.',
	},

	// I6 · content-only control — real content-lookup question.
	{
		fixtureId: 'w-i6-expected-cursor-tool-ceiling',
		type: 'insight',
		title: 'Cursor integration — MCP tool ceiling and .cursor/rules provenance',
		content:
			"Maskin's Cursor integration uses MASKIN_MCP_PROFILE=cursor to gate a curated 18-tool allowlist.",
	},

	// I7 · verification_status — "not-yet-verified" question. Trap outranks with
	// "pending" but is not pending.
	{
		fixtureId: 'w-i7-expected-pending-real',
		type: 'insight',
		title: 'AI-generated resumes destroy hiring signal',
		content:
			'Insight from a single-source Tom MacWright observation; pending corroboration from a second independent source.',
	},
	{
		fixtureId: 'w-i7-trap-pending-terminology',
		type: 'insight',
		title: 'Pending vs verified — insight review states pending sign-off',
		content:
			'Pending verification, pending review, pending sign-off, pending insight promotion, pending queue.',
	},

	// I8 · status — "shelved vs live insights". Trap outranks with "shelved".
	{
		fixtureId: 'w-i8-expected-shelved-real',
		type: 'insight',
		title: 'Static status field cannot double as an agent wake-up channel',
		content: 'Insight shelved after two follow-on bets absorbed its recommendation.',
	},
	{
		fixtureId: 'w-i8-trap-shelved-terminology',
		type: 'insight',
		title: 'Shelved insights — how we shelve insights and why we shelve them',
		content:
			'Shelved, shelving, shelved insight state, shelve reasons, shelved workflow, shelved conventions.',
	},

	// I9 · content-only control — real content-lookup question.
	{
		fixtureId: 'w-i9-expected-tianpan-window',
		type: 'insight',
		title: 'New-user AI personalisation window is 5–15 minutes',
		content: 'Insight cites tianpan.co (2026-04-18) on new-user retention priors.',
	},

	// I10 · source_type — "insights from Slack conversations". Trap outranks
	// with "Slack" repeated but is not sourced from Slack.
	{
		fixtureId: 'w-i10-expected-slack-sourced',
		type: 'insight',
		title: 'Multi-agent orchestration moving from IDE to team-chat',
		content: 'Insight seeded from a Slack thread in #inspiration-resources on 2026-06-30.',
	},
	{
		fixtureId: 'w-i10-trap-slack-mention',
		type: 'insight',
		title: 'Slack integration surface — Slack channels, Slack webhooks, Slack mentions',
		content:
			'Slack, Slack integration, Slack channels, Slack webhooks, Slack mentions, Slack rate-limits.',
	},
]

const INSIGHT_PAIRS: readonly WorkEvalPair[] = [
	{
		pairId: 'I1',
		type: 'insight',
		dimension: 'verification_status',
		question: 'Show me only the verified insights on retrieval ranking',
		expectedFixtureIds: ['w-i1-expected-verified-real'],
		expectedExcerpt: 'Multi-source convergence',
		trapFixtureIds: ['w-i1-trap-verified-terminology'],
		candidateField: 'verification_status',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I2',
		type: 'insight',
		dimension: 'recency',
		question: 'Which insights were filed this week?',
		expectedFixtureIds: ['w-i2-expected-fresh-real'],
		expectedExcerpt: 'Claude Tag',
		trapFixtureIds: ['w-i2-trap-fresh-terminology'],
		candidateField: 't_valid',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I3',
		type: 'insight',
		dimension: 'source_type',
		question: 'Which insights came from PostHog?',
		expectedFixtureIds: ['w-i3-expected-posthog-usage'],
		expectedExcerpt: 'exit_code=0',
		trapFixtureIds: ['w-i3-trap-posthog-mention'],
		candidateField: 'source_type',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I4',
		type: 'insight',
		dimension: 'confidence',
		question: 'Give me the high-confidence insights for the Strategist to lean on',
		expectedFixtureIds: ['w-i4-expected-high-confidence-real'],
		expectedExcerpt: 'founder positioning',
		trapFixtureIds: ['w-i4-trap-high-confidence-terminology'],
		candidateField: 'confidence',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I5',
		type: 'insight',
		dimension: 'driver',
		question: 'Which insights did Sindre file?',
		expectedFixtureIds: ['w-i5-expected-driver-real'],
		expectedExcerpt: 'kill triggers',
		trapFixtureIds: ['w-i5-trap-driver-mention'],
		candidateField: 'driver_id',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I6',
		type: 'insight',
		dimension: 'content_only',
		question: 'What is the MCP tool ceiling for the Cursor integration?',
		expectedFixtureIds: ['w-i6-expected-cursor-tool-ceiling'],
		expectedExcerpt: 'MASKIN_MCP_PROFILE=cursor',
		trapFixtureIds: [],
		candidateField: null,
		hypothesisedAttributable: 'N',
	},
	{
		pairId: 'I7',
		type: 'insight',
		dimension: 'verification_status',
		question: "Which insights are still pending verification and haven't been signed off?",
		expectedFixtureIds: ['w-i7-expected-pending-real'],
		expectedExcerpt: 'Tom MacWright',
		trapFixtureIds: ['w-i7-trap-pending-terminology'],
		candidateField: 'verification_status',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I8',
		type: 'insight',
		dimension: 'status',
		question: 'Which insights got shelved after their follow-on bets absorbed them?',
		expectedFixtureIds: ['w-i8-expected-shelved-real'],
		expectedExcerpt: 'agent wake-up channel',
		trapFixtureIds: ['w-i8-trap-shelved-terminology'],
		candidateField: 'status',
		hypothesisedAttributable: 'Y',
	},
	{
		pairId: 'I9',
		type: 'insight',
		dimension: 'content_only',
		question: 'How long is the new-user AI personalisation window?',
		expectedFixtureIds: ['w-i9-expected-tianpan-window'],
		expectedExcerpt: '5–15 minutes',
		trapFixtureIds: [],
		candidateField: null,
		hypothesisedAttributable: 'N',
	},
	{
		pairId: 'I10',
		type: 'insight',
		dimension: 'source_type',
		question: 'Which insights were seeded from a Slack conversation?',
		expectedFixtureIds: ['w-i10-expected-slack-sourced'],
		expectedExcerpt: 'inspiration-resources',
		trapFixtureIds: ['w-i10-trap-slack-mention'],
		candidateField: 'source_type',
		hypothesisedAttributable: 'Y',
	},
]

// ────────────────────────────────────────────────────────────────────────────
// Aggregated exports
// ────────────────────────────────────────────────────────────────────────────

export const WORK_JOINT_CORPUS: readonly WorkCorpusEntry[] = [
	...BET_CORPUS,
	...TASK_CORPUS,
	...INSIGHT_CORPUS,
]

export const WORK_JOINT_EVAL_PAIRS: readonly WorkEvalPair[] = [
	...BET_PAIRS,
	...TASK_PAIRS,
	...INSIGHT_PAIRS,
]

// ────────────────────────────────────────────────────────────────────────────
// Self-checks — run at import time so a mis-authored pair fails loudly at
// test-load time rather than in the aggregate number.
// ────────────────────────────────────────────────────────────────────────────

if (WORK_JOINT_EVAL_PAIRS.length !== 30) {
	throw new Error(
		`WORK_JOINT_EVAL_PAIRS must have 30 entries (10 per type). Has ${WORK_JOINT_EVAL_PAIRS.length}.`,
	)
}

for (const t of ['bet', 'task', 'insight'] as const) {
	const perType = WORK_JOINT_EVAL_PAIRS.filter((p) => p.type === t)
	if (perType.length !== 10) {
		throw new Error(`Type ${t} must have exactly 10 pairs. Has ${perType.length}.`)
	}
}

const WORK_CORPUS_BY_ID = new Map(WORK_JOINT_CORPUS.map((c) => [c.fixtureId, c]))

for (const pair of WORK_JOINT_EVAL_PAIRS) {
	for (const id of [...pair.expectedFixtureIds, ...pair.trapFixtureIds]) {
		const entry = WORK_CORPUS_BY_ID.get(id)
		if (!entry) {
			throw new Error(`Pair ${pair.pairId}: fixture ${id} not in corpus.`)
		}
		if (entry.type !== pair.type) {
			throw new Error(
				`Pair ${pair.pairId} (${pair.type}): fixture ${id} has type ${entry.type}, expected ${pair.type}.`,
			)
		}
	}
	if (pair.expectedFixtureIds.length === 0) {
		throw new Error(`Pair ${pair.pairId}: must have at least one expected row.`)
	}
	if (pair.expectedExcerpt === null) {
		throw new Error(`Pair ${pair.pairId}: expectedExcerpt is required.`)
	}
	const excerpt = pair.expectedExcerpt.toLowerCase()
	const anyExpectedMatchesExcerpt = pair.expectedFixtureIds.some((id) => {
		const entry = WORK_CORPUS_BY_ID.get(id)
		if (!entry) return false
		return `${entry.title}\n${entry.content}`.toLowerCase().includes(excerpt)
	})
	if (!anyExpectedMatchesExcerpt) {
		throw new Error(
			`Pair ${pair.pairId}: expectedExcerpt "${pair.expectedExcerpt}" not present in any expected row.`,
		)
	}
	if (pair.dimension === 'content_only' && pair.candidateField !== null) {
		throw new Error(
			`Pair ${pair.pairId}: content_only pairs must have candidateField=null (no metadata field is being tested).`,
		)
	}
	if (pair.dimension !== 'content_only' && pair.candidateField === null) {
		throw new Error(`Pair ${pair.pairId}: non-content_only pairs must name a candidateField.`)
	}
	if (pair.dimension === 'content_only' && pair.hypothesisedAttributable !== 'N') {
		throw new Error(`Pair ${pair.pairId}: content_only pair should hypothesise attributable='N'.`)
	}
}

// Guardrail: fixture IDs must not collide with the knowledge-metadata bet's
// content-30 or metadata-10 IDs — a cross-fixture collision would let the
// Product Analyst pool the corpora into a single joint eval and hit
// duplicate-key seed rows.
const KNOWN_KNOWLEDGE_FIXTURE_ID_PREFIXES = ['meta-']
for (const entry of WORK_JOINT_CORPUS) {
	if (!entry.fixtureId.startsWith('w-')) {
		throw new Error(
			`Corpus entry ${entry.fixtureId}: work fixture IDs must start with "w-" to keep the namespace separate from knowledge fixture IDs.`,
		)
	}
	for (const prefix of KNOWN_KNOWLEDGE_FIXTURE_ID_PREFIXES) {
		if (entry.fixtureId.startsWith(prefix)) {
			throw new Error(
				`Corpus entry ${entry.fixtureId}: collides with knowledge fixture prefix "${prefix}".`,
			)
		}
	}
}
