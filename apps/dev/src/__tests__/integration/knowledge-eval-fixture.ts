/**
 * Gold Q/A fixture for the cited-answer eval.
 *
 * Two subsets share one fixture module:
 *   - `KNOWLEDGE_CORPUS` + `EVAL_PAIRS` — 30 content-lookup Q/A pairs, each
 *     rooted in a real validated `type=knowledge` row from Maskin's dev
 *     workspace (mined 2026-07-02). Content matches question vocabulary; the
 *     baseline (JSONB-ILIKE) is expected to do well here — this is where the
 *     content-lookup ceiling shows.
 *   - `METADATA_KNOWLEDGE_CORPUS` + `METADATA_EVAL_PAIRS` — 10 metadata-filter
 *     Q/A pairs across recency, un-superseded, confidence, and verification.
 *     Each expected row is deliberately paired with a trap row that outranks
 *     it under content-alone (ILIKE), so the baseline is near-zero by design.
 *     The kill-trigger judgment rides on metadata-10 alone (≥80% = pass,
 *     <80% = kill); content-30 is a legibility number, not a gate.
 *
 * The eval seeds both subsets into a fresh integration DB and runs the
 * fixture through two retrieval paths: today's `ilike(title, %q%) OR
 * ilike(content, %q%)` baseline, and `retrieveKnowledge()`'s column-aware
 * path (LEFT JOIN `knowledge_extras`, `t_invalid IS NULL`,
 * `verification_status != 'deprecated'`, rank verification → confidence).
 *
 * An on-import self-check asserts every metadata-10 pair has at least one
 * trap row that outranks the expected row under the baseline ranker — a
 * pair that doesn't stress the mechanism doesn't count.
 */

export type CorpusEntry = {
	fixtureId: string
	title: string
	content: string
}

export type EvalPair = {
	question: string
	expectedFixtureId: string
	expectedExcerpt: string
}

export type MetadataDimension = 'recency' | 'un_superseded' | 'confidence' | 'verification_status'

export type VerificationStatus = 'verified' | 'pending' | 'unverified' | 'contested' | 'deprecated'

export type Confidence = 'high' | 'medium' | 'low' | null

/**
 * Corpus entry for the metadata-filter subset. `t_valid` / `t_invalid` are
 * expressed as day offsets from the eval run's `now` (negative = past,
 * positive = future, 0 = now). The harness converts to absolute Dates at
 * seed time so tests stay deterministic across runs.
 */
export type MetadataCorpusEntry = {
	fixtureId: string
	title: string
	content: string
	tValidOffsetDays: number
	tInvalidOffsetDays: number | null
	verificationStatus: VerificationStatus
	confidence: Confidence
}

/**
 * Metadata Q/A pair. `expectedFixtureIds: []` means the correct behaviour
 * is an empty return (every ILIKE match is filtered out by metadata — e.g.
 * every candidate is `verification_status='deprecated'`).
 */
export type MetadataEvalPair = {
	pairId: string
	dimension: MetadataDimension
	question: string
	expectedFixtureIds: readonly string[]
	expectedExcerpt: string | null
	trapFixtureIds: readonly string[]
}

export const KNOWLEDGE_CORPUS: readonly CorpusEntry[] = [
	{
		fixtureId: 'status-indicator-dot-word-popover',
		title: 'Per-object status indicator: dot + word + popover (fold block name into popover title)',
		content:
			'## Pattern\n\nSurface the four AI-work states — progressing · waiting on human · stalled · idle — as a colored dot + one-word lowercase label on the objects overview row, and as a chip in the detail-page provenance row that opens a popover on hover/tap. Read-only, deep-link only.\n\n## When to reach for it\nAny object surface where a human needs to answer "does this need me?" in ≤5 seconds, without scrolling into child tasks or comments. Applies to bets today; extendable to any work object with child-task WIP + human_decision gates.',
	},
	{
		fixtureId: 'first-test-gate-invalidated-by-scope2',
		title:
			'A build-sequencing first-test gate is invalidated if scope-2 tasks land verdicts before scope-1 outcomes are observable',
		content:
			'## Rule\nWhen a bet\'s first test is a build-order halt — "ship scope-1, observe outcome X within window Y, only then unlock scope-2 build" — the gate depends on scope-2 tasks NOT landing before scope-1 has emitted observable outcomes. If a scope-2 task\'s verdict lands before the scope-1 outcome window opens, the gate is retroactively invalidated. You cannot pass a gate whose observation window closed on empty data.\n\n## Why\nThe whole point of a staged first test is to kill scope-2 build effort early if scope-1 engagement is missing.',
	},
	{
		fixtureId: 'task-dedup-at-creation-api',
		title:
			'Task dedup belongs at the creation API — per-agent guards leak once a new origin appears',
		content:
			'## Conclusion\nEnforce duplicate-task prevention at the task-creation API, not inside individual agents. Six duplicate-task incidents in ~2 weeks — five from the untracked-PR watchdog, one from a normal design-scoping breakdown — show that any single-origin fix leaks the moment a new caller does the same thing. The task-creation API is the only choke point every origin crosses; a single pre-persist check there covers watchdogs, scoping agents, humans in a hurry, and anything future.\n\n## Why the platform layer, not the agent\n- Per-agent guards ship one at a time.',
	},
	{
		fixtureId: 'separate-driver-from-status',
		title:
			'Overloading a status field as both work-state and wake-up signal breaks both jobs — separate driver from status',
		content:
			"## Claim\nWhen a workspace's status field is the only channel that fires triggers, agents will use status flips to wake each other up — not to describe the work. That collapses two independent concerns (who is driving, what stage the work is in) onto one field and breaks both jobs at once. Handoffs must mutate driver and @mention; status may mutate only on genuine transitions (research done, decision made, PR opened).\n\n## Mechanism\nThe status field carries two loads: it is a description of the work and it is a side channel for waking up agents.",
	},
	{
		fixtureId: 'merge-queue-synthetic-main-scope',
		title:
			'Merge-queue synthetic-with-main covers only the merge-boundary CI check — pick the pattern per PR-check surface, not per repo',
		content:
			'## Conclusion\nWhen a CI check needs to read files that live only on `main` (adapters, `.maskin/*.yml`-style configs, generated manifests), the choice of mechanism must match the check surface, not the repo. Two mechanisms cover disjoint surfaces:\n- Merge-queue / batched-main (Buildkite, Solana Garden pattern) runs the final pre-merge check against a synthetic merge commit that combines the PR branch with current `main`. Any file present on `main` is visible to that check at no cost. But this only fires inside the merge queue; ordinary PR checks still see only the branch.',
	},
	{
		fixtureId: 'ci-assert-loudly-never-silent-fallback',
		title:
			'CI checks whose safety depends on a resolvable resource should assert loudly, never silently fall back',
		content:
			"**Principle.** When a CI job's safety depends on a config, adapter, or shared binary that might not resolve on the branch under test, the job must assert the resource is present and hard-fail if not — never silently substitute a default. Silent-fallback is the worst failure mode: it masks the packaging gap, ships permissive defaults into `main`, and turns a safety floor into a suggestion.\n\n**Why it matters.** A floor that only binds when it loads is not a floor. If the risk-classifier adapter can't find `.maskin/protected-paths.yml`, its floors don't bind on that build.",
	},
	{
		fixtureId: 'workspace-deps-for-branch-agnostic-ci',
		title: 'Ship shared CI binaries as pnpm `workspace:*` deps to make them branch-agnostic',
		content:
			"## Conclusion\nWhen a shared internal binary or adapter must run on every branch's CI (not just `main`), land it under `packages/` and depend on it via `workspace:*`. `pnpm install` on any branch resolves to that branch's in-tree copy — no need to check out `main`, no silent fallback when a branch doesn't yet contain the file.\n\n## The gap this closes\nA tool that lives only on `main` is invisible to feature-branch CI. Concrete case in maskin: the risk-classifier adapter can't resolve `.maskin/*.yml` from a `fix/*` branch.",
	},
	{
		fixtureId: 'trim-mcp-tool-responses-default',
		title:
			'Trim MCP tool responses by default — the ecosystem has converged on field projection, pagination metadata, and resource-link fallback',
		content:
			'## Conclusion\nTrimming MCP tool responses — small default field sets, opt-in expansion, mandatory pagination metadata, and resource-link fallback for heavy graphs — is where the whole MCP ecosystem is heading, not a Maskin-local stylistic call. Four independent sources (Anthropic engineering, Google MCP Toolbox, the MCP spec community, and Microsoft/third-party writeups) converged on the same design in the last two months. External measurements put field waste in structured tool output at 85–95%.',
	},
	{
		fixtureId: 'default-view-via-named-view-sentinel',
		title:
			"Route the default/all view through named-view persistence via a sentinel slot — don't build parallel persistence",
		content:
			'## Conclusion\nWhen the observable failure of a per-user UI persistence bug is the default or all tab of a view, route that tab through the existing named-view persistence mechanism via a sentinel key (e.g. `__all__`) rather than introducing a parallel persistence system. This keeps the diff narrow, reuses a mechanism the team already trusts, and prevents the default view from drifting out of sync with named views as the persistence contract evolves.',
	},
	{
		fixtureId: 'sort-group-in-display-panel',
		title: 'Sort/Group state — surface via DisplayPanel inline reading, not chip strip',
		content:
			"## Pattern\nSort and Group state live in the toolbar's existing DisplayPanel trigger — never as chips in the filter chip strip. When either differs from defaults, the DisplayPanel trigger button grows an inline secondary reading:\n\n```\n[Display · Priority ↓ · grouped by Status]  ← non-default sort or group\n[Display]                                     ← defaults (renders nothing extra)\n```\n\n**Trigger rule (verbatim):** render the inline reading when sort !== 'createdAt' || order !== 'desc' || groupBy != null.",
	},
	{
		fixtureId: 'provenance-chips-created-updated',
		title: 'Object detail provenance — surface both createdAt and updatedAt as inline chips',
		content:
			'## Pattern\nOn any object-detail header, provenance is expressed as a row of chips using `<RelativeTime>` — no labelled row, no separator characters, no tooltip-only surfaces. The row lives in the existing flex flex-wrap items-center gap-2 container in apps/web/src/components/objects/object-document.tsx. When both timestamps exist, both render inline:\n\n```\n[Type] [Status] [Driver] [Subscribe] [👤 Created by] [<createdAt RelativeTime>] [updated <updatedAt RelativeTime>]\n```',
	},
	{
		fixtureId: 'shipfeed-inside-product-surface',
		title:
			"Agent-run public content sites are inside maskin's product surface — Shipfeed as the reference shape",
		content:
			'## Conclusion\nTreat agent-run public content sites as inside maskin\'s product surface, not adjacent to it. When a use case has the shape of an autonomous editor team curating a structured stream with scheduled rollups and a public output surface, size it as a maskin product, not a benchmark for one.\n\n## Why\nOn 2026-06-30, Sebastian shared Shipfeed (shipfeed.fyi) in #inspiration-resources with the framing "This should be a product running on maskin." That is a founder positioning signal — a direct statement that this shape of agentic product sits inside maskin\'s surface area.',
	},
	{
		fixtureId: 'multi-source-convergence-signal',
		title: 'Multi-source convergence as a ranking signal for agent-run content triage',
		content:
			'## Conclusion\nWhen an agent is triaging an incoming content stream, treat the number of independent sources reporting the same story within a time window as a first-class ranking signal. N independent sources within window T means signal; a single source means noise until corroborated. Use this primitive for ranking, dedup, and clustering — not just one of those, all three at once.\n\n## Reasoning\nEditorial newsrooms have used source convergence as a credibility filter for decades.',
	},
	{
		fixtureId: 'new-user-personalisation-window',
		title: 'New-user AI personalisation has one window — the first 5–15 minutes of session 1',
		content:
			"## Conclusion\nAny new-user AI personalisation must fire synchronously on signup, not via batch or scheduled processing. The user's prior on whether the product \"knows them\" calcifies inside 5–15 minutes of first session; once it's set, you've lost up to 75% of week-1 retention. A daily/scheduled council architecture is structurally wrong for this surface — by the time it runs, the prior is fixed.\n\n## Reasoning\ntianpan.co (2026-04-18) argues new users decide whether AI knows them within 5–15 minutes.",
	},
	{
		fixtureId: 'bets-kill-criteria-inside-telemetry',
		title: 'Bets whose kill criteria depend on telemetry shipped inside the bet cannot fire',
		content:
			"## What was tried\nA 4-week bet (Cut Developer agent token waste, 2026-06-15 → 2026-06-30) targeting a ~50% cut in Developer-agent cost via four structural levers — MCP tool-registry dedup, skill lazy-load, baked pnpm in agent-base, ENOSPC trap + host-side LRU. AC-U6 (the gate criterion) was a 30-day PostHog query against runtime_session_ended filtered to agent_name='Developer' AND exit_code=0. Because the emitter shipped inside the same bet, kill criteria could not fire until the emitter itself had accumulated 30 days of data — which never happened inside the bet window.",
	},
	{
		fixtureId: 'coarse-exit-signals-cascade',
		title: 'Coarse exit signals cascade until every consumer is migrated off the literal',
		content:
			'Generic exit codes (notably `exit 1`) hide distinct failure modes and propagate confusion to every consumer downstream — customers, operators, and even agents — until the signal is disambiguated AND every consumer is moved onto the new structured code. Introducing the enum is the easy half; walking the consumers is the half that gets skipped.\n\n## Why it cascades\nA single coarse code forces every consumer to guess what it means. The customer sees "session failed" and can\'t tell if their credits ran out or the system broke.',
	},
	{
		fixtureId: 'bet-timeline-hygiene-description-vs-comments',
		title: 'Bet timeline hygiene: description stays stable, comments carry signal only',
		content:
			"## Conclusion\nOn a bet's detail page, the description is a stable artifact and comments are the running dialogue. Agents must not duplicate facts between the two surfaces, must not litter the thread with convention debates, and must shape decision-pending comments so they stand out from routine status. When the timeline feels noisy, fix it with prose discipline (formatting, default-collapsed phases, OP-routed reply notifications, agent system-prompt guidance) before reaching for structured UI affordances like chips, session blocks, or sticky banners.",
	},
	{
		fixtureId: 'coolify-passthrough-validation',
		title:
			'Per-agent env-var credentials need the Coolify passthrough validated before any actor-config work',
		content:
			'## Conclusion\nWhen introducing a new per-agent credential to the Maskin agent runtime (e.g. POSTHOG_API_KEY_DEVELOPER, POSTHOG_API_KEY_VALIDATOR), the riskiest assumption is not whether the upstream MCP/API accepts the key. It is whether the Coolify deploy env forwards the var into the spawned agent container shell. "Key set in Coolify" is not the same as "key reaches the container." Validate the passthrough with `env | grep <PREFIX>` from inside a fresh agent session as the first step. Adding the var to an actor\'s MCP config before that check is rework-by-design.',
	},
	{
		fixtureId: 'bet-failures-expired-close-artifacts',
		title: 'Bet failures today are mostly deadline-expiry artifacts, not evidence-backed verdicts',
		content:
			"## Conclusion\nThe bet measurement pipeline does not fire at a bet's review_date. Verdicts are produced when the Product Analyst runs a periodic backlog sweep, by which point most overdue bets get auto-failed with expired_close: true and evidence_quality: null instead of an evidence-backed call. Treat any live → failed transition with expired_close: true as a process artifact, not a real verdict.\n\n## Why this matters\nIf you read the bet portfolio at face value, you will overstate the fail rate.",
	},
	{
		fixtureId: 'cursor-mcp-profile-ceiling',
		title: 'Cursor Integration — MCP tool ceiling, webhook contract, and .cursor/rules provenance',
		content:
			"Maskin's integration with Cursor follows three architecture decisions agreed during Stage 1 of the bet.\n\n**Tool ceiling.** MASKIN_MCP_PROFILE=cursor env var gates a curated ~18-tool allowlist (list_objects, get_objects, search_objects, update_objects, create_objects, create_comment, get_comments, list_actors, get_actor, list_workspaces, get_workspace_schema, list_workspace_skills, get_workspace_skill, create_file, get_file, list_files, mark_read, list_unread). Excludes admin/sessions/triggers/extensions. Tools outside the profile return method-not-found.",
	},
	{
		fixtureId: 'scoped-files-table-property-menu',
		title:
			'Scoped files-table property menu: use ghost icon + inline metadata, not unified Display panel',
		content:
			'When adding column/property visibility controls to a subsection of a page (e.g., the Files table), prefer a ghost Button size=icon trigger next to the subsection heading over reusing the page-level Display panel. The files-table has 5 properties (Size, Created, Modified, Kind, Uploaded by) plus a locked-on Filename — enough to warrant its own control. The popover menu uses checkboxes with an inline metadata layout (`Size · Created Jun 9 · Modified 2d ago`) rather than a tabular grid, keeping row density consistent.',
	},
	{
		fixtureId: 'github-deployment-status-signal',
		title: 'GitHub deployment_status is the production-deploy signal source for Maskin',
		content:
			'Maskin uses GitHub deployment_status webhooks (state=success, environment=production) as the single production-deploy signal source for bet/task attribution. Two-pass SHA matching: Pass 1 matches SHA to merge-commit SHAs from push/pull_request.merged events. Pass 2 uses branch-name or PR-head-SHA fallback for squash-merges and umbrella PRs. bet.metadata.deployed_at is the canonical field, clearing metadata.awaiting_deploy atomically.',
	},
	{
		fixtureId: 'multi-agent-orchestration-team-chat',
		title: 'Multi-agent coding orchestration is moving from IDE plugins to team-chat interfaces',
		content:
			'Multi-agent coding orchestration is shifting from individual developer IDEs to team-chat-native interfaces. Linzumi, a YC-launched product (June 2026, founded by a 3x YC founder and former OpenAI employee), lets teams kick off work, review agent output, and ship code all from a single chat conversation — treating the coding agent orchestration layer as a conversational surface rather than an IDE plugin or dashboard. This signals a broader pattern: as multi-agent coding workflows mature, the coordination layer is evolving into a team communication primitive.',
	},
	{
		fixtureId: 'event-design-transfers-to-discovery',
		title:
			'Event design principles transfer to product discovery: deliberate experience, structured participation, outcome-focused facilitation',
		content:
			'Conference and event design principles transfer directly to product discovery. Three practices from event design apply: (1) Deliberate experience design — treat a discovery session like an event, designing who participates, when, and in what format with the same intentionality as a conference agenda. (2) Structured participation — use facilitation techniques that surface diverse signals rather than letting the loudest voices dominate, just as event designers structure attendee engagement. (3) Outcome-focused facilitation — guide discovery sessions toward decisions and learning outcomes, not features.',
	},
	{
		fixtureId: 'anthropic-80-percent-ai-code',
		title: 'Organizational dynamics of operating with 80%+ AI-generated production code',
		content:
			"Anthropic's internal dogfooding data shows that over 80% of merged production code is written by Claude. This creates novel organizational dynamics that any company approaching high AI-adoption rates will eventually face. Customer-facing PMs must navigate a codebase where the majority of contributions are AI-generated, which shifts how they understand product capabilities, debug issues, and communicate with engineering. Engineering teams face a tension: maintaining craft standards and code quality when most code is not hand-authored.",
	},
	{
		fixtureId: 'ai-legal-accountability-perverse-incentive',
		title:
			'AI legal accountability: companies are liable for AI errors, and dodging liability creates perverse incentives',
		content:
			"A German court ruled Google liable for errors introduced by its AI-generated overviews, establishing that AI agents are legal agents of the deploying organization: if a human writer's errors would make the company liable, AI errors should too. Bruce Schneier extended this to a critical corollary — if companies could shift blame onto an AI, they'd have perverse incentives to replace human professionals (doctors, lawyers, engineers) with cheaper but legally unaccountable AI systems. This creates an anti-perverse-incentive argument: holding organizations accountable for AI outputs is not just about redress.",
	},
	{
		fixtureId: 'claude-tag-65-percent',
		title: "Anthropic's internal Claude Tag generates 65% of product team code",
		content:
			"Anthropic's internal instance of Claude Tag — its persistent AI coworker integrated into Slack and developer tooling — generates 65% of the company's product team code. This metric was shared by Andrej Karpathy and represents production-scale evidence that persistent AI teammates deliver meaningful engineering output in real organizational settings. The 65% figure is corroborated by Lennys Sanayei's interview coverage indicating over 80% of Anthropic's merged production code is written by Claude.",
	},
	{
		fixtureId: 'claude-tag-three-capabilities',
		title: "Claude Tag's three capabilities define the persistent Slack teammate pattern",
		content:
			"Anthropic's Claude Tag establishes three product capabilities that define what a persistent AI teammate in Slack looks like:\n\n1. Per-channel memory — a single Claude instance per channel that retains context over time, eliminating the need to re-explain past discussions.\n2. Asynchronous task execution — Claude can work on tasks independently while humans focus elsewhere, delivering results when ready rather than requiring synchronous interaction.\n3. Ambient proactive mode — Claude monitors channels it's invited to, proactively flags relevant information, and follows up on unresolved threads without waiting to be @mentioned.",
	},
	{
		fixtureId: 'ai-generated-resumes-destroy-signal',
		title: 'AI-generated application materials destroy hiring signal',
		content:
			'When all candidates use the same AI tools to generate resumes, portfolios, and application materials, hiring managers lose the ability to distinguish genuine ability from AI-polished output. The surface quality of applications increases uniformly, but their diagnostic value as a hiring signal drops to near zero — creating a paradox where more AI-generated output means less information about the candidate.\n\nTom MacWright (via Simon Willison, June 2026) observes that the perfected, AI-generated resume is generic and impersonal.',
	},
	{
		fixtureId: 'mcp-as-data-ingestion',
		title: 'MCP as a data ingestion protocol',
		content:
			"MCP services can function as general-purpose data ingestion endpoints, not just chat-oriented tool interfaces. Simon Willison demonstrated this by using Mozilla's MDN MCP service to programmatically extract the full mdn/browser-compat-data repository — a 66MB structured dataset — and convert it into a searchable SQLite database published via Datasette Lite. The workflow used Claude Code (Opus 4.8) to write the conversion script and Codex Desktop (GPT-5.5) to build the CI pipeline that force-pushes the database to an orphan branch for CDN hosting.",
	},
]

if (KNOWLEDGE_CORPUS.length !== 30) {
	throw new Error(`KNOWLEDGE_CORPUS must have 30 entries (has ${KNOWLEDGE_CORPUS.length}).`)
}

/**
 * Questions phrased as a Maskin teammate might actually ask in Slack — mix
 * of on-title vocabulary (should ILIKE-hit) and oblique / synonym-heavy
 * phrasings (should ILIKE-miss). This gives the baseline a real spread
 * instead of saturating at 100% by construction.
 */
export const EVAL_PAIRS: readonly EvalPair[] = [
	{
		question:
			'I want users to know at a glance whether a bet needs their input — how do we show it?',
		expectedFixtureId: 'status-indicator-dot-word-popover',
		expectedExcerpt: 'colored dot + one-word lowercase label',
	},
	{
		question:
			'Can phase-two work close before phase-one has produced observable data, without breaking the gating logic?',
		expectedFixtureId: 'first-test-gate-invalidated-by-scope2',
		expectedExcerpt: 'gate is retroactively invalidated',
	},
	{
		question:
			'A watchdog keeps creating duplicate tasks — where should we fix this once so future callers can not repeat it?',
		expectedFixtureId: 'task-dedup-at-creation-api',
		expectedExcerpt: 'task-creation API is the only choke point',
	},
	{
		question: 'Why is it a mistake to have agents flip status just to wake each other up?',
		expectedFixtureId: 'separate-driver-from-status',
		expectedExcerpt: 'Handoffs must mutate driver and @mention',
	},
	{
		question:
			"Our floor config only lives on the trunk — how do we still validate PR builds against it, and what's the limitation?",
		expectedFixtureId: 'merge-queue-synthetic-main-scope',
		expectedExcerpt: 'only fires inside the merge queue',
	},
	{
		question:
			'If a build can not resolve a required policy file, is it OK to fall back to a default so the pipeline keeps moving?',
		expectedFixtureId: 'ci-assert-loudly-never-silent-fallback',
		expectedExcerpt: 'assert the resource is present and hard-fail',
	},
	{
		question:
			"How do we ship a shared internal tool so every feature branch's pipeline can run it without pulling the trunk?",
		expectedFixtureId: 'workspace-deps-for-branch-agnostic-ci',
		expectedExcerpt: 'workspace:*',
	},
	{
		question:
			"Our tool responses are exhausting the model's context — what's the industry-wide default shape we should adopt?",
		expectedFixtureId: 'trim-mcp-tool-responses-default',
		expectedExcerpt: 'small default field sets, opt-in expansion',
	},
	{
		question:
			'Our unnamed default view lost its per-user filters — should we build a separate persistence path just for it?',
		expectedFixtureId: 'default-view-via-named-view-sentinel',
		expectedExcerpt: '__all__',
	},
	{
		question: 'Where do sort and grouping controls belong when they differ from defaults?',
		expectedFixtureId: 'sort-group-in-display-panel',
		expectedExcerpt: 'DisplayPanel',
	},
	{
		question:
			'How do we surface both when a record was made and when it was last edited on its detail page?',
		expectedFixtureId: 'provenance-chips-created-updated',
		expectedExcerpt: 'RelativeTime',
	},
	{
		question:
			'Sebastian shared a live newsletter site run by agents — should we treat that as a competitor benchmark or as inside our own scope?',
		expectedFixtureId: 'shipfeed-inside-product-surface',
		expectedExcerpt: "inside maskin's product surface, not adjacent to it",
	},
	{
		question:
			'A newsroom agent is ranking incoming stories. What signal from traditional editorial practice should it lean on?',
		expectedFixtureId: 'multi-source-convergence-signal',
		expectedExcerpt: 'source convergence',
	},
	{
		question:
			'How long do we have before a new user decides whether our AI actually understands them?',
		expectedFixtureId: 'new-user-personalisation-window',
		expectedExcerpt: 'first 5–15 minutes',
	},
	{
		question:
			"We planned to measure the success of a project using a metric emitted by that same project's shipped code. What goes wrong?",
		expectedFixtureId: 'bets-kill-criteria-inside-telemetry',
		expectedExcerpt: 'kill criteria could not fire',
	},
	{
		question:
			'We introduced a richer set of session outcome codes. Why has the customer confusion not gone away?',
		expectedFixtureId: 'coarse-exit-signals-cascade',
		expectedExcerpt: 'walking the consumers is the half that gets skipped',
	},
	{
		question:
			"On a project's page, should a decision-pending update go into the description or into the running thread?",
		expectedFixtureId: 'bet-timeline-hygiene-description-vs-comments',
		expectedExcerpt: 'description is a stable artifact',
	},
	{
		question:
			'Our deploy platform stores a secret for the agent runtime, but the agent can not read it. What should we check first?',
		expectedFixtureId: 'coolify-passthrough-validation',
		expectedExcerpt: 'env | grep <PREFIX>',
	},
	{
		question:
			'The portfolio shows a lot of failed projects. Why should we not treat those as real evidence-based losses?',
		expectedFixtureId: 'bet-failures-expired-close-artifacts',
		expectedExcerpt: 'expired_close: true',
	},
	{
		question: 'How do we cap which internal tools the IDE-embedded agent is allowed to call?',
		expectedFixtureId: 'cursor-mcp-profile-ceiling',
		expectedExcerpt: 'MASKIN_MCP_PROFILE=cursor',
	},
	{
		question:
			'We want a small trigger next to a sub-table heading to toggle its columns. Should we reuse the page-level Display panel or build something scoped?',
		expectedFixtureId: 'scoped-files-table-property-menu',
		expectedExcerpt: 'ghost Button size=icon trigger',
	},
	{
		question: 'Which GitHub event tells us a change is actually live in production?',
		expectedFixtureId: 'github-deployment-status-signal',
		expectedExcerpt: 'deployment_status',
	},
	{
		question:
			'Coding assistants used to live in editors — where is the coordination layer moving now?',
		expectedFixtureId: 'multi-agent-orchestration-team-chat',
		expectedExcerpt: 'team-chat-native interfaces',
	},
	{
		question:
			'A colleague running an offsite thinks their facilitation craft has no bearing on how we run product discovery. Is that right?',
		expectedFixtureId: 'event-design-transfers-to-discovery',
		expectedExcerpt: 'Deliberate experience design',
	},
	{
		question:
			"How much of what actually gets merged in Anthropic's codebase is now authored by Claude?",
		expectedFixtureId: 'anthropic-80-percent-ai-code',
		expectedExcerpt: 'over 80% of merged production code',
	},
	{
		question:
			'If companies could dodge blame for AI mistakes, why would that make things worse for professionals?',
		expectedFixtureId: 'ai-legal-accountability-perverse-incentive',
		expectedExcerpt: 'perverse incentives to replace human professionals',
	},
	{
		question:
			"How much of Anthropic's product code is coming out of their persistent Slack teammate?",
		expectedFixtureId: 'claude-tag-65-percent',
		expectedExcerpt: '65% of the company',
	},
	{
		question:
			"We are designing our own always-on chat teammate. What three behaviours does Anthropic's version show that we should match?",
		expectedFixtureId: 'claude-tag-three-capabilities',
		expectedExcerpt: 'Per-channel memory',
	},
	{
		question:
			'If every candidate now runs their resume through the same model, what happens to how well resumes actually discriminate?',
		expectedFixtureId: 'ai-generated-resumes-destroy-signal',
		expectedExcerpt: 'diagnostic value as a hiring signal drops to near zero',
	},
	{
		question:
			'Simon Willison pulled a whole compatibility dataset out of an MCP endpoint. What does that tell us about what MCP can be used for?',
		expectedFixtureId: 'mcp-as-data-ingestion',
		expectedExcerpt: 'general-purpose data ingestion endpoints',
	},
]

if (EVAL_PAIRS.length !== 30) {
	throw new Error(`EVAL_PAIRS must have 30 entries (has ${EVAL_PAIRS.length}).`)
}

const CORPUS_IDS = new Set(KNOWLEDGE_CORPUS.map((c) => c.fixtureId))
for (const pair of EVAL_PAIRS) {
	if (!CORPUS_IDS.has(pair.expectedFixtureId)) {
		throw new Error(`EvalPair references unknown fixtureId ${pair.expectedFixtureId}.`)
	}
	const corpus = KNOWLEDGE_CORPUS.find((c) => c.fixtureId === pair.expectedFixtureId)
	if (!corpus) throw new Error(`EvalPair references unknown fixtureId ${pair.expectedFixtureId}.`)
	const haystack = `${corpus.title}\n${corpus.content}`.toLowerCase()
	if (!haystack.includes(pair.expectedExcerpt.toLowerCase())) {
		throw new Error(
			`EvalPair ${pair.expectedFixtureId}: expectedExcerpt not present in seeded content.`,
		)
	}
}

// ── Metadata-filter subset ──────────────────────────────────────────────────
//
// 10 Q/A pairs stress the retrieval class the promoted `knowledge_extras`
// columns unlock — the axis JSONB-ILIKE ceilings on. Split across four
// dimensions (recency, un-superseded, confidence, verification). Each pair
// pairs an "expected" row (right on metadata, matching the question)
// with one or more "trap" rows that outrank the expected row on ILIKE
// alone. The self-check at the bottom of the file asserts this invariant.

export const METADATA_KNOWLEDGE_CORPUS: readonly MetadataCorpusEntry[] = [
	// R1 · recency · trap invalidated by t_invalid
	{
		fixtureId: 'meta-r1-expected-sprint-2w',
		title: 'Sprint length — 2 weeks',
		content: 'Sprint length is now 2 weeks. Sprints run bi-weekly.',
		tValidOffsetDays: -7,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-r1-trap-sprint-3w',
		title: 'Sprint length — 3 weeks (older, superseded)',
		content:
			'Sprint length was 3 weeks for a long time. Long-form sprint planning notes. Sprint retro notes are long.',
		tValidOffsetDays: -365,
		tInvalidOffsetDays: -120,
		verificationStatus: 'verified',
		confidence: 'high',
	},

	// R2 · recency · retrieval has no `t_valid > now` filter → expected miss
	{
		fixtureId: 'meta-r2-expected-squash-only',
		title: 'Merge policy — squash-only (in effect)',
		content: 'The merge policy is squash-only. Merge policy has been squash-only for weeks.',
		tValidOffsetDays: -30,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-r2-trap-rebase-only',
		title: 'Merge policy — rebase-only (upcoming from +14d)',
		content:
			'New merge policy: rebase-only. Merge policy switches to rebase-only. Policy details cover current PRs. Merge policy migration steps here. Policy history: squash to rebase. Current merge policy under review. The merge policy update ships soon.',
		tValidOffsetDays: 14,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},

	// R3 · recency · retrieval has no recency sort → expected miss
	{
		fixtureId: 'meta-r3-expected-import-recent',
		title: 'Style-guide import ordering — alphabetical',
		content: 'The style-guide rule for import ordering is alphabetical. Applies to all modules.',
		tValidOffsetDays: -14,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-r3-trap-import-older',
		title: 'Style-guide import ordering — by-size (older, latest phrasing from 2025)',
		content:
			'Older style-guide rule for import ordering: by size. Prior style-guide rule mentions ordering. Import ordering rule notes are extensive. Rule details for imports. Latest style-guide compilation of rules.',
		tValidOffsetDays: -90,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},

	// C1 · confidence · tokens tie → confidence high > low resolves it
	{
		fixtureId: 'meta-c1-expected-sebastian-founder',
		title: "Sebastian's role — founder",
		content: 'Sebastian is the founder. His role: founder.',
		tValidOffsetDays: 0,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-c1-trap-sebastian-cofounder',
		title: "Sebastian's role — cofounder ex-consultant (older framing)",
		content: "Sebastian's role: cofounder and ex-consultant. His prior role.",
		tValidOffsetDays: -60,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'low',
	},

	// C2 · confidence · tokens tie → confidence high > NULL resolves it
	{
		fixtureId: 'meta-c2-expected-billing-sentry',
		title: 'Billing incidents tracker — Sentry',
		content: 'We track billing incidents in Sentry.',
		tValidOffsetDays: 0,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-c2-trap-billing-archive',
		title: 'Billing incidents tracker — archive spreadsheet (legacy notes)',
		content: 'We used to track billing incidents in a spreadsheet.',
		tValidOffsetDays: -180,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: null,
	},

	// V1 · verification · tokens tie → verified > unverified resolves it
	{
		fixtureId: 'meta-v1-expected-migrations-new',
		title: 'Run migrations locally — new command',
		content:
			'How to run migrations locally: use the new tool. Migrations run locally with the updated CLI.',
		tValidOffsetDays: -3,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-v1-trap-migrations-old',
		title: 'How to run migrations locally — older take with more overlap',
		content:
			'Run migrations locally using the old command. To run migrations locally, use the older approach. Migrations run locally, though this is not verified. Local migrations runbook. Locally we run migrations.',
		tValidOffsetDays: -60,
		tInvalidOffsetDays: null,
		verificationStatus: 'unverified',
		confidence: 'high',
	},

	// V2 · verification · trap deprecated → excluded even with stronger content
	{
		fixtureId: 'meta-v2-expected-runner-gha',
		title: 'CI runner — GitHub Actions',
		content: 'We use GitHub Actions as our CI runner. The runner is Actions-hosted.',
		tValidOffsetDays: 0,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-v2-trap-runner-circle',
		title: 'CI runner — CircleCI (legacy, deprecated)',
		content:
			'We used CircleCI as our CI runner. Prior runner setup. CircleCI runner details. In-use during the old era.',
		tValidOffsetDays: -500,
		tInvalidOffsetDays: null,
		verificationStatus: 'deprecated',
		confidence: 'high',
	},

	// V3 · verification · only trap deprecated exists → expected: empty return
	{
		fixtureId: 'meta-v3-trap-oncall-pagerduty',
		title: 'On-call vendor — PagerDuty (deprecated)',
		content:
			'We use PagerDuty as our on-call paging vendor. Deprecated on-call paging setup, no verified alternative.',
		tValidOffsetDays: -500,
		tInvalidOffsetDays: null,
		verificationStatus: 'deprecated',
		confidence: 'high',
	},

	// U1 · un-superseded · trap invalidated by supersede (t_invalid=recent)
	{
		fixtureId: 'meta-u1-expected-oncall-bob',
		title: 'On-call infra rotation this week — Bob',
		content: 'Bob is on-call for infra this week.',
		tValidOffsetDays: -1,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-u1-trap-oncall-alice',
		title: 'On-call infra rotation last week — Alice (superseded)',
		content:
			'Alice was on-call for infra this week. The on-call infra shift changed. Weekly on-call rotation. Alice covered infra this week previously.',
		tValidOffsetDays: -8,
		tInvalidOffsetDays: -1,
		verificationStatus: 'verified',
		confidence: 'high',
	},

	// U2 · un-superseded · chain A → B → C, only C live
	{
		fixtureId: 'meta-u2-expected-retention-live',
		title: 'Data retention policy — live (2026, current version)',
		content: 'Data retention policy: 90 days for logs, 7 years for audit.',
		tValidOffsetDays: -14,
		tInvalidOffsetDays: null,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-u2-trap-retention-a',
		title: 'Data retention policy — archived v1 (superseded)',
		content: 'Data retention policy v1: 30 days for logs. Data retention policy details.',
		tValidOffsetDays: -400,
		tInvalidOffsetDays: -200,
		verificationStatus: 'verified',
		confidence: 'high',
	},
	{
		fixtureId: 'meta-u2-trap-retention-b',
		title: 'Data retention policy — archived v2 (superseded)',
		content: 'Data retention policy v2: 60 days. Data retention policy notes.',
		tValidOffsetDays: -200,
		tInvalidOffsetDays: -30,
		verificationStatus: 'verified',
		confidence: 'high',
	},
]

if (METADATA_KNOWLEDGE_CORPUS.length !== 20) {
	throw new Error(
		`METADATA_KNOWLEDGE_CORPUS must have 20 entries (has ${METADATA_KNOWLEDGE_CORPUS.length}).`,
	)
}

export const METADATA_EVAL_PAIRS: readonly MetadataEvalPair[] = [
	{
		pairId: 'R1',
		dimension: 'recency',
		question: 'How long is a sprint?',
		expectedFixtureIds: ['meta-r1-expected-sprint-2w'],
		expectedExcerpt: '2 weeks',
		trapFixtureIds: ['meta-r1-trap-sprint-3w'],
	},
	{
		pairId: 'R2',
		dimension: 'recency',
		question: "What's our current merge policy?",
		expectedFixtureIds: ['meta-r2-expected-squash-only'],
		expectedExcerpt: 'squash-only',
		trapFixtureIds: ['meta-r2-trap-rebase-only'],
	},
	{
		pairId: 'R3',
		dimension: 'recency',
		question: 'Latest style-guide rule for import ordering?',
		expectedFixtureIds: ['meta-r3-expected-import-recent'],
		expectedExcerpt: 'alphabetical',
		trapFixtureIds: ['meta-r3-trap-import-older'],
	},
	{
		pairId: 'C1',
		dimension: 'confidence',
		question: "What's Sebastian's role?",
		expectedFixtureIds: ['meta-c1-expected-sebastian-founder'],
		expectedExcerpt: 'founder',
		trapFixtureIds: ['meta-c1-trap-sebastian-cofounder'],
	},
	{
		pairId: 'C2',
		dimension: 'confidence',
		question: 'Where do we track billing incidents?',
		expectedFixtureIds: ['meta-c2-expected-billing-sentry'],
		expectedExcerpt: 'Sentry',
		trapFixtureIds: ['meta-c2-trap-billing-archive'],
	},
	{
		pairId: 'V1',
		dimension: 'verification_status',
		question: 'How do we run migrations locally?',
		expectedFixtureIds: ['meta-v1-expected-migrations-new'],
		expectedExcerpt: 'new tool',
		trapFixtureIds: ['meta-v1-trap-migrations-old'],
	},
	{
		pairId: 'V2',
		dimension: 'verification_status',
		question: "What's the CI runner we use?",
		expectedFixtureIds: ['meta-v2-expected-runner-gha'],
		expectedExcerpt: 'GitHub Actions',
		trapFixtureIds: ['meta-v2-trap-runner-circle'],
	},
	{
		pairId: 'V3',
		dimension: 'verification_status',
		question: 'Which vendor do we use for on-call paging?',
		expectedFixtureIds: [],
		expectedExcerpt: null,
		trapFixtureIds: ['meta-v3-trap-oncall-pagerduty'],
	},
	{
		pairId: 'U1',
		dimension: 'un_superseded',
		question: 'Who is on-call for infra this week?',
		expectedFixtureIds: ['meta-u1-expected-oncall-bob'],
		expectedExcerpt: 'Bob',
		trapFixtureIds: ['meta-u1-trap-oncall-alice'],
	},
	{
		pairId: 'U2',
		dimension: 'un_superseded',
		question: "What's our data retention policy?",
		expectedFixtureIds: ['meta-u2-expected-retention-live'],
		expectedExcerpt: '90 days',
		trapFixtureIds: ['meta-u2-trap-retention-a', 'meta-u2-trap-retention-b'],
	},
]

if (METADATA_EVAL_PAIRS.length !== 10) {
	throw new Error(`METADATA_EVAL_PAIRS must have 10 entries (has ${METADATA_EVAL_PAIRS.length}).`)
}

// ── Self-check for the metadata-10 pairs ────────────────────────────────────
//
// Every metadata pair must have at least one trap row that outranks its
// expected row(s) under the JSONB-ILIKE baseline (score DESC → title ASC).
// If a pair doesn't have a trap that beats it on content alone, the pair
// isn't stressing the metadata mechanism and the fixture must fail its
// import so the gap is caught at test-load time, not silently ignored in
// the aggregate number.

const METADATA_STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'been',
	'but',
	'by',
	'can',
	'could',
	'did',
	'do',
	'does',
	'for',
	'from',
	'has',
	'have',
	'how',
	'i',
	'if',
	'in',
	'into',
	'is',
	'it',
	'its',
	'just',
	'not',
	'of',
	'on',
	'or',
	'over',
	'past',
	'per',
	'should',
	'so',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'they',
	'this',
	'to',
	'up',
	'was',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'why',
	'will',
	'with',
	'you',
	'your',
])

function tokenizeForSelfCheck(text: string): string[] {
	const raw = text
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
	const seen = new Set<string>()
	const out: string[] = []
	for (const word of raw) {
		if (word.length < 3) continue
		if (METADATA_STOPWORDS.has(word)) continue
		if (seen.has(word)) continue
		seen.add(word)
		out.push(word)
	}
	return out
}

function scoreRow(tokens: readonly string[], entry: MetadataCorpusEntry): number {
	const haystack = `${entry.title}\n${entry.content}`.toLowerCase()
	let score = 0
	for (const token of tokens) {
		if (haystack.includes(token.toLowerCase())) score += 1
	}
	return score
}

const METADATA_CORPUS_BY_ID = new Map<string, MetadataCorpusEntry>(
	METADATA_KNOWLEDGE_CORPUS.map((c) => [c.fixtureId, c]),
)

for (const pair of METADATA_EVAL_PAIRS) {
	if (pair.trapFixtureIds.length === 0) {
		throw new Error(`Metadata pair ${pair.pairId}: no trap rows defined.`)
	}
	for (const trapId of pair.trapFixtureIds) {
		if (!METADATA_CORPUS_BY_ID.has(trapId)) {
			throw new Error(`Metadata pair ${pair.pairId}: trap fixture ${trapId} not in corpus.`)
		}
	}
	for (const expectedId of pair.expectedFixtureIds) {
		if (!METADATA_CORPUS_BY_ID.has(expectedId)) {
			throw new Error(`Metadata pair ${pair.pairId}: expected fixture ${expectedId} not in corpus.`)
		}
	}
	if (pair.expectedFixtureIds.length === 0 && pair.expectedExcerpt !== null) {
		throw new Error(
			`Metadata pair ${pair.pairId}: empty-expected pair must have expectedExcerpt=null.`,
		)
	}
	if (pair.expectedFixtureIds.length > 0 && pair.expectedExcerpt === null) {
		throw new Error(`Metadata pair ${pair.pairId}: non-empty expected must have expectedExcerpt.`)
	}

	// expectedExcerpt must be present in at least one expected row's haystack.
	if (pair.expectedFixtureIds.length > 0 && pair.expectedExcerpt !== null) {
		const needle = pair.expectedExcerpt.toLowerCase()
		const anyMatch = pair.expectedFixtureIds.some((id) => {
			const entry = METADATA_CORPUS_BY_ID.get(id)
			if (!entry) return false
			return `${entry.title}\n${entry.content}`.toLowerCase().includes(needle)
		})
		if (!anyMatch) {
			throw new Error(
				`Metadata pair ${pair.pairId}: expectedExcerpt not present in any expected row.`,
			)
		}
	}

	// Core self-check: at least one trap row outranks the expected row(s) under
	// the JSONB-ILIKE baseline ranker (score DESC → title ASC → id ASC).
	// If the pair has no expected row (empty-return), the trap just needs to
	// have score > 0 so it appears in the baseline candidates at all.
	const tokens = tokenizeForSelfCheck(pair.question)
	if (tokens.length === 0) {
		throw new Error(
			`Metadata pair ${pair.pairId}: question yields no tokens after stopword/length filtering.`,
		)
	}

	const trapEntries = pair.trapFixtureIds.map((id) => {
		const entry = METADATA_CORPUS_BY_ID.get(id)
		if (!entry) throw new Error(`missing trap ${id}`)
		return entry
	})
	const expectedEntries = pair.expectedFixtureIds.map((id) => {
		const entry = METADATA_CORPUS_BY_ID.get(id)
		if (!entry) throw new Error(`missing expected ${id}`)
		return entry
	})

	const trapMaxScore = Math.max(...trapEntries.map((e) => scoreRow(tokens, e)))
	if (pair.expectedFixtureIds.length === 0) {
		if (trapMaxScore <= 0) {
			throw new Error(
				`Metadata pair ${pair.pairId}: trap rows do not match any question token — pair does not stress the mechanism.`,
			)
		}
		continue
	}

	// Non-empty expected: verify at least one trap outranks at least one
	// expected row in (score DESC, title ASC).
	const trapWinner = trapEntries
		.map((e) => ({ entry: e, score: scoreRow(tokens, e) }))
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score
			return a.entry.title.localeCompare(b.entry.title)
		})[0]
	const expectedWinner = expectedEntries
		.map((e) => ({ entry: e, score: scoreRow(tokens, e) }))
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score
			return a.entry.title.localeCompare(b.entry.title)
		})[0]

	if (!trapWinner || !expectedWinner) {
		throw new Error(`Metadata pair ${pair.pairId}: unable to rank rows.`)
	}

	const trapBeats =
		trapWinner.score > expectedWinner.score ||
		(trapWinner.score === expectedWinner.score &&
			trapWinner.entry.title.localeCompare(expectedWinner.entry.title) < 0)

	if (!trapBeats) {
		throw new Error(
			`Metadata pair ${pair.pairId}: no trap row outranks the expected row under ILIKE-baseline (trap ${trapWinner.entry.fixtureId} score=${trapWinner.score} title="${trapWinner.entry.title}", expected ${expectedWinner.entry.fixtureId} score=${expectedWinner.score} title="${expectedWinner.entry.title}"). Pair does not stress the metadata mechanism.`,
		)
	}
}

// Guardrail: metadata fixture IDs must not collide with content-30 IDs.
{
	const contentIds = new Set(KNOWLEDGE_CORPUS.map((c) => c.fixtureId))
	for (const entry of METADATA_KNOWLEDGE_CORPUS) {
		if (contentIds.has(entry.fixtureId)) {
			throw new Error(`Metadata fixture ${entry.fixtureId} collides with a content-30 fixtureId.`)
		}
	}
}
