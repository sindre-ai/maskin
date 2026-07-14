// Shared eval fixture — 20 knowledge Q&A pairs plus a small v1 knowledge corpus.
//
// Task ownership: T5 authored this fixture module because T4's baseline run needs
// the same 20 pairs and the same corpus that T5's router runs against; keeping the
// data in one place is what makes the ≥30% comparison honest. T4's harness at
// `knowledge-eval.test.ts` (dump-into-context regime + baseline recording) and T5's
// harness at `knowledge-eval-router.test.ts` (router regime) both import from here.
//
// Freeze contract: once T4 records the baseline against this fixture, the 20 pairs
// and the corpus are frozen for Stage 1. Do not add, remove, or reword pairs — a
// changed fixture invalidates the baseline and T5's ≥30% claim. If Stage 2 needs a
// larger eval, spin a versioned successor (`knowledge-eval-fixture-v2.ts`).
//
// Provenance: at time of authoring, T2's real workspace backfill and T4's live
// `bet_meta` fixture had not landed. This fixture is prototype-scale content
// authored in-repo, structured to match the T1 v1 spec exactly so the router
// mechanism can be exercised end-to-end. Once T2's v1 corpus is queryable, T4 may
// swap the `CORPUS` constant for a real-corpus loader — the shape stays the same.

import type { KnowledgeArticle } from '../../lib/knowledge/router'

export interface EvalPair {
	id: string
	question: string
	goldArticleId: string
	answerFragment: string
}

// The v1 corpus the router routes across. Each article carries the full v1
// frontmatter set per docs/reference/knowledge-format.md.
export const CORPUS: KnowledgeArticle[] = [
	{
		id: 'a1000001-0000-0000-0000-000000000001',
		title: 'GitHub App installation tokens have ~1h TTL',
		body: 'GitHub App installation tokens expire after roughly one hour. Sessions that mint an installation token at session start and then attempt a git-write more than 50 minutes later will see a 401 on push, merge-via-API, and PR-review-approve. The correct first-move on a late-run 401 is to check the delta between token-mint time and the write attempt, and to confirm the installation ID has not rotated on the target repo. Refresh the token — do not treat this as a credentials problem.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			summary:
				'GitHub App installation tokens have a ~1h TTL. Late-run 401s on git-writes should be first diagnosed as token-mint delta or installation-ID churn, not credential rot.',
			tags: ['topic:integrations', 'topic:agent-architecture', 'provenance:writer'],
			confidence: 'high',
			scope: 'product-area',
			last_validated_at: '2026-07-13',
		},
	},
	{
		id: 'a1000002-0000-0000-0000-000000000002',
		title: 'PG NOTIFY payloads must stay under 8KB or the trigger rolls back',
		body: 'Postgres NOTIFY has an 8KB payload cap. When a trigger passes a large field (a full content column, a stringified diff, an unbounded description) into pg_notify, the entire triggering INSERT silently rolls back with no error surfaced to the caller. The pattern is to strip or truncate free-text columns in the trigger body before assembling the notify payload — see migration 0006_notify_drop_data.sql for the canonical shape. Any new trigger that touches pg_notify should be reviewed for payload size against realistic data, not just seed fixtures.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			summary:
				'PG NOTIFY payloads over 8KB cause silent rollback of the triggering INSERT. Truncate large fields in the trigger body; use 0006_notify_drop_data.sql as the reference pattern.',
			tags: ['topic:data-model', 'topic:architecture'],
			confidence: 'high',
			scope: 'workspace',
			last_validated_at: '2026-07-10',
		},
	},
	{
		id: 'a1000003-0000-0000-0000-000000000003',
		title: 'Idempotency-Key is required on every write endpoint',
		body: 'Every write endpoint on the Maskin API accepts an Idempotency-Key header and treats a repeat request with the same key as a no-op returning the original response. Clients (including agents) should generate a stable key per intent and re-use it on retry; without a key the server proceeds without deduplication and duplicate side effects are possible on network retry.',
		metadata: {
			format_version: 'v1',
			doc_type: 'reference',
			summary:
				'All Maskin write endpoints accept Idempotency-Key. Callers generate one key per intent and re-use on retry; no key means no dedup and duplicate side effects on retry.',
			tags: ['topic:architecture', 'topic:integrations'],
			confidence: 'high',
			scope: 'workspace',
			last_validated_at: '2026-07-01',
		},
	},
	{
		id: 'a1000004-0000-0000-0000-000000000004',
		title: 'Anthropic just-in-time retrieval outperforms system-prompt stuffing',
		body: `The Anthropic engineering position is that agents should retrieve knowledge just-in-time at the tool surface, not by pre-loading everything into the system prompt. Preloading burns tokens on facts the agent may never need; on-demand retrieval targets exactly the article the current step calls for. This applies to Maskin's knowledge corpus: the index/router should be the default context source, and dump-into-context is a fallback only when routing fails.`,
		metadata: {
			format_version: 'v1',
			doc_type: 'topic_page',
			summary:
				'Anthropic argues just-in-time retrieval at the tool surface beats system-prompt stuffing. Maskin applies this by routing over the knowledge index rather than dumping the corpus.',
			tags: ['topic:agent-architecture', 'topic:knowledge-system'],
			confidence: 'high',
			scope: 'universal',
			last_validated_at: '2026-07-14',
		},
	},
	{
		id: 'a1000005-0000-0000-0000-000000000005',
		title: 'Drizzle column objects render unqualified inside correlated sql subqueries',
		body: 'A correlated subquery written inside a Drizzle sql template that interpolates column objects like sessions.agentServerId will render the column without a table qualifier. Postgres then binds the bare column name to the inner table, and the correlation is never true — the aggregate quietly returns zero. Fix by writing table-qualified literal SQL inside the template, or by using LEFT JOIN LATERAL with explicit aliases. Real-Postgres integration tests catch this; mocked unit tests do not.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			summary:
				'Interpolating Drizzle column objects into a correlated sql subquery renders them unqualified — Postgres binds to the inner table and the aggregate returns zero. Use qualified literal SQL or LATERAL joins.',
			tags: ['topic:data-model', 'topic:code-review'],
			confidence: 'high',
			scope: 'product-area',
			last_validated_at: '2026-07-08',
		},
	},
	{
		id: 'a1000006-0000-0000-0000-000000000006',
		title: 'Container sessions store agent files in S3-compatible storage',
		body: 'Maskin runs agents inside Docker containers spun up by session-manager. Persistent per-agent files (skills, learnings, memory) live in S3-compatible object storage — SeaweedFS in dev, real S3 in production. The apps/dev/src/services/agent-storage.ts module handles pull-on-start and push-on-pause; container filesystems are otherwise ephemeral. Any long-lived artifact an agent produces must be routed through agent-storage or it will be lost on container teardown.',
		metadata: {
			format_version: 'v1',
			doc_type: 'reference',
			summary:
				'Agent files persist in S3-compatible storage (SeaweedFS in dev). Container filesystems are ephemeral; use apps/dev/src/services/agent-storage.ts to persist across sessions.',
			tags: ['topic:agent-architecture', 'topic:architecture'],
			confidence: 'high',
			scope: 'product-area',
			last_validated_at: '2026-07-05',
		},
	},
	{
		id: 'a1000007-0000-0000-0000-000000000007',
		title: 'GitHub MCP server env key must be GITHUB_PERSONAL_ACCESS_TOKEN',
		body: 'The @modelcontextprotocol/server-github MCP subprocess reads its token exclusively from the GITHUB_PERSONAL_ACCESS_TOKEN environment variable. Passing the token under the key GITHUB_TOKEN inside the MCP env block is silently ignored; the subprocess makes unauthenticated requests that surface later as 403/rate-limit errors. This is distinct from the container-level GITHUB_TOKEN env var used by envsubst and the gh CLI — that one stays as is. Only the object key inside the MCP env block must be GITHUB_PERSONAL_ACCESS_TOKEN.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			summary:
				'The github MCP server reads from GITHUB_PERSONAL_ACCESS_TOKEN, not GITHUB_TOKEN. Wrong key silently produces unauthenticated calls that fail later as 403.',
			tags: ['topic:integrations', 'topic:agent-architecture'],
			confidence: 'high',
			scope: 'product-area',
			last_validated_at: '2026-07-12',
		},
	},
	{
		id: 'a1000008-0000-0000-0000-000000000008',
		title: 'Bi-temporal validity: new facts invalidate old, never overwrite',
		body: 'The industry pattern for staleness in knowledge stores is bi-temporal: an old fact is closed off with an end-date rather than deleted, and the new fact is inserted with its own valid-from date. Readers pick the fact whose validity window contains the current time. Graphiti popularized this pattern for agent memory; Maskin adopts it so historical claims stay auditable and contradictions become explicit rather than lost.',
		metadata: {
			format_version: 'v1',
			doc_type: 'topic_page',
			summary:
				'Bi-temporal validity closes old facts with an end-date and adds new facts with their own valid-from; nothing is overwritten. Contradictions become explicit and history is auditable.',
			tags: ['topic:knowledge-system', 'topic:data-model'],
			confidence: 'medium',
			scope: 'universal',
			last_validated_at: '2026-07-14',
		},
	},
	{
		id: 'a1000009-0000-0000-0000-000000000009',
		title: 'Turbo globalPassThroughEnv is the only way env vars reach child tasks',
		body: `Turborepo filters environment variables by default: any env var not listed in turbo.json's globalPassThroughEnv is silently unavailable to dev, build, and test tasks even when it is set in .env. This is the recurring source of "the integration works locally but not through turbo" bugs — new integration credentials, new API keys, and new feature flags must be added to globalPassThroughEnv or they will not reach the code that reads them.`,
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			summary:
				'Turbo silently filters env vars not listed in turbo.json globalPassThroughEnv. New env vars must be added there or child tasks cannot read them.',
			tags: ['topic:architecture', 'topic:integrations'],
			confidence: 'high',
			scope: 'workspace',
			last_validated_at: '2026-07-06',
		},
	},
	{
		id: 'a1000010-0000-0000-0000-000000000010',
		title: 'Context engineering explains ~80% of agent performance variance',
		body: 'External research through 2026 converges on the finding that agent output quality is dominated by what tokens are in the context window, not by model size or agent-count topology. Roughly 80% of measured performance variance across recent agent systems traces back to context construction — retrieval, ordering, compression, and pruning. This is the load-bearing argument for treating context engineering as a first-class, systematic discipline rather than a per-agent tuning exercise.',
		metadata: {
			format_version: 'v1',
			doc_type: 'topic_page',
			summary:
				'Roughly 80% of agent performance variance traces to context construction, not model or topology. Context engineering is the leverage point.',
			tags: ['topic:knowledge-system', 'topic:agent-architecture', 'topic:measurement-analytics'],
			confidence: 'medium',
			scope: 'universal',
			last_validated_at: '2026-07-14',
		},
	},
	{
		id: 'a1000011-0000-0000-0000-000000000011',
		title: 'Number() returns NaN on non-numeric strings and propagates silently to SQL',
		body: `Number('abc') evaluates to NaN, and NaN passes through arithmetic without raising. When a route handler does Number(req.query.limit) and the caller sends 'abc', the resulting NaN reaches the query layer where it produces unexpected results or Postgres errors depending on the driver. The fix is Number.isFinite(raw) && raw > 0 ? raw : DEFAULT — always validate at the boundary before use.`,
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			summary:
				'Number() returns NaN on non-numeric input and propagates silently to SQL. Always guard with Number.isFinite() and fall back to a default.',
			tags: ['topic:code-review', 'topic:architecture'],
			confidence: 'high',
			scope: 'workspace',
			last_validated_at: '2026-07-11',
		},
	},
	{
		id: 'a1000012-0000-0000-0000-000000000012',
		title: 'Bets are shaped, time-boxed outcomes with a define → active → verdict lifecycle',
		body: 'Every substantive workspace decision is framed as a bet. A bet moves through define (shaping), active (in flight), and a terminal verdict (succeeded, failed, qualified, paused). Tasks are children of bets and inherit their outcome. A bet in define has a driver, an anchor, and pending acceptance criteria; a bet in active has AC gates that must land; a terminal bet must produce a verdict statement and a learning that flows into knowledge.',
		metadata: {
			format_version: 'v1',
			doc_type: 'topic_page',
			summary:
				'Bets are shaped, time-boxed outcomes with a define → active → verdict lifecycle. Tasks are children; verdicts feed the knowledge loop.',
			tags: ['topic:bet-lifecycle', 'topic:pipeline-orchestration'],
			confidence: 'high',
			scope: 'workspace',
			last_validated_at: '2026-07-14',
		},
	},
]

// 20 frozen eval pairs. Each pair names the article whose content answers it
// (goldArticleId) and a short answerFragment the model's output should include.
// The router regime is scored on whether goldArticleId is present in its top-K;
// the dump regime is scored on the same fragment against the model's output.
export const EVAL_PAIRS: EvalPair[] = [
	{
		id: 'p01',
		question: 'Why does a session get a 401 on git push about an hour after start?',
		goldArticleId: 'a1000001-0000-0000-0000-000000000001',
		answerFragment: 'installation token',
	},
	{
		id: 'p02',
		question: 'What is the first diagnostic step for a late-run GitHub write 401?',
		goldArticleId: 'a1000001-0000-0000-0000-000000000001',
		answerFragment: 'token-mint delta',
	},
	{
		id: 'p03',
		question: 'A trigger with pg_notify silently rolls back the insert. What is going on?',
		goldArticleId: 'a1000002-0000-0000-0000-000000000002',
		answerFragment: '8KB',
	},
	{
		id: 'p04',
		question: 'How should new pg_notify triggers handle large content fields?',
		goldArticleId: 'a1000002-0000-0000-0000-000000000002',
		answerFragment: 'truncate',
	},
	{
		id: 'p05',
		question: 'How do write endpoints deduplicate retried requests?',
		goldArticleId: 'a1000003-0000-0000-0000-000000000003',
		answerFragment: 'Idempotency-Key',
	},
	{
		id: 'p06',
		question: 'What is Anthropic\u2019s position on where retrieval should happen for agents?',
		goldArticleId: 'a1000004-0000-0000-0000-000000000004',
		answerFragment: 'just-in-time',
	},
	{
		id: 'p07',
		question: 'Why prefer routing over dumping the whole knowledge corpus?',
		goldArticleId: 'a1000004-0000-0000-0000-000000000004',
		answerFragment: 'system prompt',
	},
	{
		id: 'p08',
		question: 'A COUNT(*) subquery in Drizzle keeps returning zero. Where is the bug likely?',
		goldArticleId: 'a1000005-0000-0000-0000-000000000005',
		answerFragment: 'unqualified',
	},
	{
		id: 'p09',
		question: 'Where do persistent agent files live between container sessions?',
		goldArticleId: 'a1000006-0000-0000-0000-000000000006',
		answerFragment: 'S3',
	},
	{
		id: 'p10',
		question: 'A container-run agent lost the skill file it wrote. Why?',
		goldArticleId: 'a1000006-0000-0000-0000-000000000006',
		answerFragment: 'ephemeral',
	},
	{
		id: 'p11',
		question:
			'The github MCP subprocess returns 403 on every call. What is the likely env misconfig?',
		goldArticleId: 'a1000007-0000-0000-0000-000000000007',
		answerFragment: 'GITHUB_PERSONAL_ACCESS_TOKEN',
	},
	{
		id: 'p12',
		question: 'Why should we not overwrite superseded facts in the knowledge store?',
		goldArticleId: 'a1000008-0000-0000-0000-000000000008',
		answerFragment: 'bi-temporal',
	},
	{
		id: 'p13',
		question: 'How do bi-temporal knowledge readers pick the current fact?',
		goldArticleId: 'a1000008-0000-0000-0000-000000000008',
		answerFragment: 'validity window',
	},
	{
		id: 'p14',
		question: 'A new env var is set in .env but not visible to dev. What did we miss?',
		goldArticleId: 'a1000009-0000-0000-0000-000000000009',
		answerFragment: 'globalPassThroughEnv',
	},
	{
		id: 'p15',
		question: 'What share of agent performance variance is attributed to context construction?',
		goldArticleId: 'a1000010-0000-0000-0000-000000000010',
		answerFragment: '80%',
	},
	{
		id: 'p16',
		question: 'Why treat context engineering as its own discipline instead of per-agent tuning?',
		goldArticleId: 'a1000010-0000-0000-0000-000000000010',
		answerFragment: 'variance',
	},
	{
		id: 'p17',
		question: 'Number(req.query.limit) came back as NaN and hit the DB. What is the safe pattern?',
		goldArticleId: 'a1000011-0000-0000-0000-000000000011',
		answerFragment: 'Number.isFinite',
	},
	{
		id: 'p18',
		question: 'What phases does a bet move through?',
		goldArticleId: 'a1000012-0000-0000-0000-000000000012',
		answerFragment: 'define',
	},
	{
		id: 'p19',
		question: 'What is the relationship between a bet and its tasks?',
		goldArticleId: 'a1000012-0000-0000-0000-000000000012',
		answerFragment: 'children',
	},
	{
		id: 'p20',
		question: 'What must a terminal bet produce that feeds the knowledge loop?',
		goldArticleId: 'a1000012-0000-0000-0000-000000000012',
		answerFragment: 'verdict',
	},
]

// Deterministic seed. Pinned so any regime running the fixture (dump-into-context in
// T4's harness, router in T5's) produces identical token counts across runs.
export const FIXTURE_SEED = 't5-router-20260714-1'
