/**
 * Representative agent-query fixture — Phase 0 measurement harness (T8).
 *
 * Purpose: score dump-into-context vs. router-regime reads on a set of
 * queries that reflect the shape of what agents in this pipeline actually
 * ask the knowledge type, not just the 20-pair T4 fixture. Domain scope
 * matches T6's audit finding — the agent-pipeline slice: tags in
 * {code-review-pattern, agent-architecture, pipeline-orchestration,
 * senior-developer, code-reviewer, skills, agent-pipeline}.
 *
 * The 35 articles below are hand-authored from real conventions and
 * pitfalls that agents in this workspace already reach for:
 *   - `.claude/rules/*` (known pitfalls, testing, integrations, frontend)
 *   - `CLAUDE.md` invariants (bias to action, never merge, plain language)
 *   - `apps/web/CLAUDE.md` responsive/design-system rules
 *   - the workspace prompt-scaffold (KNOWLEDGE_NUDGES, get_objects parsing)
 *
 * Every article carries v1 frontmatter (`format_version`, `doc_type`,
 * `tags`, `scope`, `summary`, `confidence`) so the router-regime consumer
 * (T10) can drive it as-is. A subset of five articles deliberately omits
 * `format_version` — this mirrors the mixed real corpus T6 flagged (145 of
 * 200 non-v1 rows had no `doc_type`; ~90% of the 1,132-row corpus is not
 * v1). Retrieval accuracy on those pairs measures the router's behaviour
 * against a non-clean corpus.
 *
 * Fixture invariants:
 *   - 35 corpus entries, 30 eval pairs.
 *   - Every `EvalPair.expectedFixtureId` resolves to exactly one entry.
 *   - Every `expectedExcerpt` is present in either the title or body of
 *     its gold entry (module-level self-check enforces both).
 *   - Article ids are stable, ascending strings — deterministic router
 *     tiebreak (see `apps/dev/src/lib/knowledge/router.ts`).
 *
 * DO NOT reorder or trim this fixture — reproducibility of the paired
 * harness rides on the exact query/article set. Extending it is a
 * follow-up task, not a reviewer patch.
 */

export type KnowledgeScope = 'workspace' | 'product-area' | 'org' | 'universal'

export type RepresentativeArticle = {
	fixtureId: string
	title: string
	body: string
	metadata: {
		format_version?: string
		doc_type?: string
		tags?: string[]
		scope?: KnowledgeScope | string
		summary?: string
		confidence?: 'low' | 'medium' | 'high'
	}
}

export type RepresentativePair = {
	question: string
	expectedFixtureId: string
	expectedExcerpt: string
}

// The source of this fixture is the bet branch head at T8 pickup — pinning
// the commit lets any future run of the paired harness reproduce the same
// article set even if the file is later extended.
export const REPRESENTATIVE_SOURCE_COMMIT = '8b4fa80956f27424da44db75ea6b716bbd7d3411'
export const REPRESENTATIVE_SEED = 'bet/context-engineering-format:8b4fa80:t8-repr-v1'

export const REPRESENTATIVE_CORPUS: readonly RepresentativeArticle[] = [
	{
		fixtureId: 'a01-pg-notify-8kb-limit',
		title: 'PG NOTIFY payload cap: pg_notify silently rolls back the triggering INSERT above 8KB',
		body: '## Rule\nPostgres pg_notify has an 8KB payload limit. When a trigger builds a NOTIFY payload larger than 8KB, the whole triggering INSERT is silently rolled back — no warning, no error, the row simply does not appear.\n\n## When to check\nAny DB trigger that calls pg_notify(). Especially triggers over tables with a free-text body column (content, description, message).\n\n## Fix pattern\nStrip or truncate the large fields before building the payload. See migration 0006_notify_drop_data.sql for the established pattern on the events table. Re-introduced for session_logs in PR #224.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:pg-notify', 'topic:database', 'senior-developer', 'code-review-pattern'],
			scope: 'workspace',
			summary:
				'pg_notify > 8KB rolls back the INSERT silently; strip content before building the NOTIFY payload.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a02-shell-injection-env-key',
		title: 'Shell injection via untrusted env var key interpolation — validate before export',
		body: '## Claim\nInterpolating an untrusted string into a shell `export KEY=...` command is command injection. If the key can be attacker-controlled, arbitrary shell runs.\n\n## Fix\nValidate the key against a strict allowlist regex: `^[A-Za-z_][A-Za-z0-9_]*$`. Reject anything else at the boundary. When you can, use array-based spawn(cmd, args) without shell:true so no interpolation is even possible.\n\n## Reference incident\nPR #230 — buildEnvExports() shipped shell injection through the env-var key path.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:security',
				'topic:shell-injection',
				'senior-developer',
				'code-reviewer',
				'code-review-pattern',
			],
			scope: 'workspace',
			summary:
				'Validate env var keys against `^[A-Za-z_][A-Za-z0-9_]*$` before interpolating into shell commands.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a03-numeric-parsing-nan',
		title: 'Number() returns NaN on non-numeric input and propagates silently into SQL',
		body: '## Rule\nNumber("abc") is NaN, and NaN survives arithmetic and comparison without failing. When it reaches a SQL query it produces empty results or weird errors — no validation failure at parse time.\n\n## Fix\nAlways guard parsed numbers: `Number.isFinite(raw) && raw > 0 ? raw : 20`. Enforce a range and a default at the parse boundary. Apply to every HTTP query/path param and config value read as a number.\n\n## Reference\nPR #235 — NaN from Number(req.query.limit) reached the SQL layer.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:input-validation',
				'topic:numeric-parsing',
				'senior-developer',
				'code-review-pattern',
			],
			scope: 'workspace',
			summary:
				'Guard Number() with Number.isFinite + bounds + default — NaN silently propagates to SQL otherwise.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a04-accent-token-invisible-light-mode',
		title: 'bg-accent on a text-free indicator (dot, rail, badge) is near-invisible in light mode',
		body: '## Rule\n--accent is a near-white background token in light mode. Applying `bg-accent` to a purely visual element — an unread dot, a gutter rail, a status pip — with no `text-accent-foreground` sibling produces a near-invisible shape in light mode, correct-looking in dark.\n\n## Fix\nUse `bg-primary` for indicators that must be visible in both modes. Reserve `bg-accent` for backgrounds that are always paired with `text-accent-foreground` (e.g. the "Needs you" pill).\n\n## History\nIntroduced on the unread dot and decision-point gutter rail in PR #622, fixed on `bet/timeline-ux`.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:design-ux', 'topic:tailwind-tokens', 'code-reviewer', 'code-review-pattern'],
			scope: 'product-area',
			summary:
				'bg-accent on text-free indicators (dots, rails) is invisible in light mode — use bg-primary instead.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a05-drizzle-correlated-subquery-unqualified',
		title:
			'Drizzle column objects inside a correlated `sql` subquery render without table qualifiers',
		body: '## Failure mode\nInterpolating a Drizzle column object (e.g. `${sessions.agentServerId}`) inside a raw `` sql`` `` template that builds a correlated scalar subquery renders the column name unqualified. The outer-table reference silently binds to the inner table, the correlation is never true, and the aggregate returns 0/empty. No error — just wrong numbers.\n\n## Fix\nWrite the correlated columns as literal, table-qualified SQL inside the template: `` sql`... WHERE sessions.agent_server_id = agent_servers.id ...` ``. Or use a LEFT JOIN LATERAL with explicit aliases. Cover with a real-Postgres integration test — mocked db.select misses it.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:drizzle',
				'topic:sql',
				'topic:database',
				'senior-developer',
				'code-review-pattern',
			],
			scope: 'workspace',
			summary:
				'Interpolating Drizzle column objects in a correlated raw sql subquery renders unqualified — use table-qualified literal SQL.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a06-missing-events-audit-log',
		title: 'Every entity mutation must insert an events row — silent audit-trail failure otherwise',
		body: '## Rule\nCLAUDE.md invariant: events logged on every mutation (create/update/delete). Skipping the events insert is silent — the mutation succeeds, no error is raised, but the audit trail is broken and SSE-based real-time invalidation never fires.\n\n## When to check\nAny db.update() or db.insert() against a first-class entity (integrations, sessions, objects, triggers, workspaces, actors). Especially service-layer wrappers like markRevoked, updateStatus — easy to miss because they hide the mutation behind a helper.\n\n## Fix pattern\nFollow every mutation with `db.insert(events).values({...})`. Service methods without direct access to actorId should query the row first for createdBy/workspaceId. See TokenManager.markRevoked() for the established pattern.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:events',
				'topic:audit-log',
				'topic:realtime',
				'senior-developer',
				'code-reviewer',
			],
			scope: 'workspace',
			summary:
				'Every entity mutation (insert/update/delete) must be followed by a db.insert(events).values(...) call.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a07-github-mcp-env-key',
		title: 'GitHub MCP server reads its token from GITHUB_PERSONAL_ACCESS_TOKEN, not GITHUB_TOKEN',
		body: '## Rule\n@modelcontextprotocol/server-github reads the auth token exclusively from GITHUB_PERSONAL_ACCESS_TOKEN. Passing it under `GITHUB_TOKEN` in the MCP server env object is silently ignored — the subprocess makes unauthenticated calls, which show up later as 403 / rate-limit shapes on every GitHub tool call.\n\n## Fix\nThe env object key must be GITHUB_PERSONAL_ACCESS_TOKEN. The value (${GITHUB_TOKEN} placeholder or literal) is unchanged. This is distinct from the container-level GITHUB_TOKEN read by envsubst / gh CLI — that one stays as-is. Only the MCP server env key changes.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:integrations',
				'topic:github',
				'topic:mcp',
				'code-reviewer',
				'code-review-pattern',
			],
			scope: 'workspace',
			summary:
				'@modelcontextprotocol/server-github requires the env key GITHUB_PERSONAL_ACCESS_TOKEN — not GITHUB_TOKEN.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a08-dry-component-reuse',
		title: 'Component reuse hierarchy — exhaust existing shadcn/shared/feature before creating',
		body: '## Rule\nThe #1 frontend rule is DRY. Before building anything new, exhaust every existing option in strict order: (1) shadcn/ui primitives in components/ui, (2) shared components in components/shared, (3) feature components, (4) compose primitives + shared, (5) only then a new component. Creating one is genuinely rare.\n\n## When it is OK to create\nAll of these must be true: no existing component fits; the pattern will be reused in multiple places (not one-off); it cannot be built by composing existing components.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: ['topic:design-ux', 'topic:frontend', 'senior-developer', 'code-reviewer'],
			scope: 'product-area',
			summary:
				'Frontend component reuse order: shadcn/ui → shared → feature → composed → new (last resort).',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a09-shadcn-plain-as-is',
		title: 'Use shadcn/ui primitives plain — do not wrap them in custom abstractions',
		body: '## Rule\nshadcn/ui components are the foundation of the design system, built on Radix. Use them plain — default variants, default sizes. Do not override height/border/padding/text size. Do not wrap `<Button>` in `<MyButton>` or `<Dialog>` in `<CustomDialog>`.\n\n## How to add a new primitive\n`npx shadcn@latest add <component>` — never hand-write a primitive. Every interactive element (select, dialog, checkbox) uses the Radix-based equivalent from components/ui — never raw HTML `<select>` / `<dialog>` / `<input type="checkbox">`.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: ['topic:design-ux', 'topic:frontend', 'topic:shadcn', 'senior-developer'],
			scope: 'product-area',
			summary:
				'Use shadcn/ui primitives plain — no wrappers, default variants, and add new ones via the CLI.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a10-responsive-ship-gate-viewports',
		title: 'Frontend ship-gate viewports: 375px, 768px, 1024px — mobile is non-negotiable',
		body: '## Rule\nEvery UI surface must work at three viewports: 375px (mobile), 768px (iPad portrait), 1024px (iPad landscape). No hardcoded widths. No skipped mobile collapse. Use Tailwind breakpoints (md:, lg:).\n\n## E2E gate\nPlaywright specs assert every user-visible surface at the ship-gate viewports — use `SHIP_GATE_VIEWPORTS` from helpers/viewports.ts in the viewport loop. Full guidelines in apps/web/CLAUDE.md under "Responsive (mobile + iPad)".',
		metadata: {
			format_version: 'v1',
			doc_type: 'reference',
			tags: ['topic:design-ux', 'topic:frontend', 'topic:responsive', 'senior-developer'],
			scope: 'product-area',
			summary:
				'Every frontend surface must work at 375 / 768 / 1024 px — mobile responsiveness is non-negotiable.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a11-integration-test-required-db-changes',
		title:
			'DB / schema / migration / write-route changes require an integration test against real Postgres',
		body: '## Rule\nAny change to packages/db/schema, a migration file in packages/db/drizzle/, or a route/service that performs DB writes must add or extend an integration test in apps/dev/src/__tests__/integration/ that exercises the change against real Postgres.\n\n## Why\nThe integration harness (global-setup.ts) drops/recreates the public schema and replays every migration in order — it is the only harness that can catch DB-semantics failures (unique constraints, FK cascade, ON CONFLICT correctness, correlated subquery rendering, pg_notify rollbacks). Mocked-db unit tests cannot substitute.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:testing',
				'topic:database',
				'topic:integration-tests',
				'senior-developer',
				'code-reviewer',
			],
			scope: 'workspace',
			summary:
				'Schema / migration / write-route changes require an integration test against real Postgres — mocks miss DB-semantics failures.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a12-e2e-spec-required-frontend-changes',
		title: 'User-visible frontend changes require a Playwright spec at the ship-gate viewports',
		body: '## Rule\nAny change to a user-visible frontend surface must add or extend a Playwright spec in apps/e2e/src/tests/ that asserts the surface works at 375 / 768 / 1024 px, in both light and dark colour schemes when it uses colour tokens.\n\n## What the spec must cover\nInteraction (click / drag / fill / submit and persist after reload). Visibility at touch viewports — no opacity:0 or hover-only reveals. `page.emulateMedia({ colorScheme: ... })` assertions for key elements when the surface uses tokens like bg-accent.\n\n## Never\nDo NOT auto-heal specs or use --agents on the spec before commit. Only raw playwright test output counts as evidence.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:testing', 'topic:e2e', 'topic:playwright', 'senior-developer', 'code-reviewer'],
			scope: 'workspace',
			summary:
				'User-visible frontend changes require a Playwright spec at 375 / 768 / 1024 px, both colour schemes.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a13-mock-db-tests-cannot-catch-db-semantics',
		title:
			'Mocked-DB unit tests cannot catch DB-semantics failures — write integration tests for those',
		body: '## Rule\nThe mocked-db unit tests in apps/dev/src/__tests__/setup.ts (using `mockResults`) exist for route-level validation — auth, 404, input errors, response shape. They cannot substitute for integration tests when the code depends on DB semantics.\n\n## What mocks miss\nUnique-constraint violation; FK cascade on delete; ON CONFLICT branch selection; correlated subquery rendering; pg_notify payload rollback. All of these need a real Postgres.\n\n## Where integration tests live\napps/dev/src/__tests__/integration/*.test.ts, run with `pnpm test:integration -- --run`.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:testing', 'topic:database', 'senior-developer', 'code-review-pattern'],
			scope: 'workspace',
			summary:
				'Mocked-db tests cover route validation only — DB semantics (constraints, cascades, ON CONFLICT) need integration tests.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a14-hosted-mcp-before-custom',
		title:
			'For integrations with a hosted MCP endpoint, use mcp-remote — never write a custom route',
		body: '## Rule\nSeveral major providers (Gmail, Google Calendar, Linear, PostHog) run their own MCP endpoints that accept the OAuth bearer token Maskin already holds. Use these hosted endpoints via `mcp-remote` — dramatically less code, stays up-to-date automatically.\n\n## Concrete shape\n`mcp: { command: "npx", args: ["-y", "mcp-remote", "https://<provider>.mcp.example/mcp/v1"], envKey: "PROVIDER_TOKEN" }`. The frontend preset uses `{ type: "http", url: ..., headers: { Authorization: "Bearer ${PROVIDER_TOKEN}" } }`.\n\n## Do not do\nBuild a custom in-process MCP route under apps/dev/src/lib/integrations/mcp/ for a provider that has a hosted endpoint. See PRs #880 and #891 for custom code closed in favour of hosted.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: ['topic:integrations', 'topic:mcp', 'senior-developer'],
			scope: 'workspace',
			summary:
				'Prefer hosted MCP endpoints via mcp-remote over custom in-process routes for supported providers.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a15-turbo-globalpassthroughenv',
		title:
			'New runtime env vars must be listed in turbo.json globalPassThroughEnv or Turbo hides them',
		body: '## Rule\nTurbo filters environment variables — anything not listed in `globalPassThroughEnv` in turbo.json is silently unavailable to dev/build tasks even when set in .env. New env vars — especially integration provider credentials, webhook secrets, API keys — must be added there.\n\n## Detection\nSymptom is always the same: the var reads as undefined in the running app despite being present in .env. Grep turbo.json for the key first.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:integrations', 'topic:env-vars', 'topic:turbo', 'senior-developer'],
			scope: 'workspace',
			summary:
				'Add new runtime env vars to turbo.json globalPassThroughEnv — otherwise Turbo silently hides them from tasks.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a16-x-workspace-id-header-auth',
		title:
			'Routes that read X-Workspace-Id are already membership-checked — do not flag missing isWorkspaceMember',
		body: '## Reviewer pitfall\nauthMiddleware queries workspaceMembers and returns 404 before the handler runs when the request carries X-Workspace-Id. A header-scoped route does NOT need its own `isWorkspaceMember()` check.\n\n## Where the check still belongs\nBy-ID routes where the workspace is derived from the resource — GET /objects/:id where the object row supplies the workspace. There, the middleware has not yet seen the workspace and the handler must check membership.\n\n## Rule\nDo not flag missing isWorkspaceMember on header-scoped routes. Adding a redundant call is harmless defence-in-depth, but its absence is not a security hole.',
		metadata: {
			format_version: 'v1',
			doc_type: 'reference',
			tags: ['topic:auth', 'topic:code-review-pattern', 'code-reviewer'],
			scope: 'workspace',
			summary:
				'Header-scoped routes (X-Workspace-Id) are already membership-checked by authMiddleware — do not flag missing isWorkspaceMember.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a17-bet-define-until-agreed',
		title: 'A bet stays in define until the format spec and measurement harness are human-agreed',
		body: '## Rule\nOn a bet whose Phase 0 gates the write-side work behind a format spec and a measurement harness, the bet stays in `define` until both land and are human-agreed. Moving it to `active` earlier decouples the build phase from the gate that is supposed to be blocking it.\n\n## Phase dependency\nPhases are dependent, not parallel. Format + eval must land before any Phase 1 read/write automation starts. Do not open Phase 1 tasks before the gate clears.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:bet-lifecycle', 'topic:agent-pipeline', 'pipeline-orchestration'],
			scope: 'workspace',
			summary:
				'A gated bet stays in define until the format spec + measurement harness are human-agreed; Phase 1 tasks wait.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a18-bet-vertical-slice',
		title: 'Vertical slice over horizontal build-out — prove one domain end-to-end first',
		body: '## Rule\nOn a substrate-shaped bet, pick one domain and take it end-to-end (format → write → index → read → measure) before generalising. Most of the work in the surrounding research only pays off conditionally — a working thin slice must exist before committing to write-side automation or retrieval infra.\n\n## Practical shape\nOne domain, five to ten exemplars, a measurement harness, a router path. Kill criterion up front — if the pilot shows no token/accuracy win, stop and rescope; do not push to Phase 2.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: ['topic:bet-lifecycle', 'topic:agent-architecture', 'pipeline-orchestration'],
			scope: 'workspace',
			summary:
				'Vertical slice over horizontal build-out — one domain end-to-end, then generalise; add a kill criterion up front.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a19-never-pause-silently',
		title: 'Never pause silently — leave a comment before the session ends if you cannot finish',
		body: '## Invariant\nIf you cannot finish a task, leave a comment before the session ends: what you tried, where you got stuck, what the next session or a human needs to unblock. This invariant trumps everything else.\n\n## Why\nA silently-stalled task looks live but is dead. The next actor picks it up assuming it is progressing, and the loop starves. A comment lets whoever comes next act, even if that next actor is a human.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:agent-architecture', 'topic:handoff', 'senior-developer', 'agent-pipeline'],
			scope: 'workspace',
			summary:
				'Never end a session with a task stalled under your name — always leave a handoff comment first.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a20-nothing-blocked-invariant',
		title: 'Nothing is ever blocked — the "blocked" status does not exist in the pipeline',
		body: '## Invariant\nNo blocked status exists in this workspace — never set one. Tasks are ordered by number (T1, T2, T3); a lower-numbered task is context, never a gate. An unmerged predecessor PR does not stop the follow-on work.\n\n## The two exceptions\nOnly two things ever wait on a human, and neither is a status the agent sets: a human moving a bet from `signal` to `define`, and a human approving a `ux` or `architecture` decision. Everything else has an unblock — usually action, sometimes an @mention on the Strategist.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:agent-architecture', 'topic:bet-lifecycle', 'agent-pipeline'],
			scope: 'workspace',
			summary:
				'No blocked status exists in the pipeline — task numbering is context, not a gate; only human bet-signal-to-define + ux/architecture approval wait on humans.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a21-you-never-merge',
		title: 'Senior Developer never merges — Code Reviewer owns the merge under the risk gate',
		body: '## Invariant\nThe Senior Developer hands work off cleanly at in_review and never merges. The Code Reviewer owns the merge: task PRs into the bet branch, umbrella into main, under the risk-gate. A human is pulled in only when a risk signal fires.\n\n## What that means in practice\nDo not run `gh pr merge` from a Developer session, ever. Move the task to in_review, @mention the next actor with a clear brief, and let the Reviewer run its own checks.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:agent-pipeline', 'topic:code-review', 'senior-developer', 'code-reviewer'],
			scope: 'workspace',
			summary:
				'Senior Developer never merges — Reviewer owns merges under the risk gate. Hand off clean at in_review.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a22-plain-language-only',
		title: 'Plain language only in comments, PR titles, and Ship Notes — no internal scaffolding',
		body: '## Invariant\nStep numbers, skill names, mode names are internal scaffolding — they never appear in comments, PR titles or descriptions, or Ship Notes. Say what you did and why, in plain language a human reader can act on.\n\n## Litmus test\nIf a phrase would only make sense to someone reading the pipeline prompt, rewrite it. "Ran ship" is scaffolding; "self-checks passed, PR is green" is a reader-actionable sentence.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: ['topic:agent-pipeline', 'topic:communication', 'senior-developer', 'agent-pipeline'],
			scope: 'workspace',
			summary:
				'Plain-language only in comments, PR titles, Ship Notes — never mention step numbers, skill names, or mode names.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a23-clone-agent-workspace-not-tmp',
		title: 'Clone the repo into /agent/workspace, not /tmp — tmpfs is 512 MB and installs fill it',
		body: '## Rule\nAlways clone into /agent/workspace/<repo-name>. Cloning into /tmp fills the 512 MB tmpfs partway through `pnpm install` and later bash commands silently exit 1 without printing a useful error.\n\n## Why silent\nOnce tmpfs is full, write syscalls fail but subsequent reads look normal. A `pnpm build` after the install completes will exit 1 with no clear cause — pointing at the install, not the disk.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:agent-runtime',
				'topic:filesystem',
				'senior-developer',
				'pipeline-orchestration',
			],
			scope: 'workspace',
			summary:
				'Clone repos into /agent/workspace, never /tmp — tmpfs is 512 MB and fills silently during pnpm install.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a24-get-objects-parsing',
		title: 'get_objects response parsing — object fields live at result.object, not the top level',
		body: '## Rule\nThe get_objects tool returns each result as `{ id, success, result: { object: { title, status, ... } } }`. Accessing `.results[0].title` reads undefined; the correct path is `.results[0].result.object.title`.\n\n## Where to remember it\nEvery agent script that consumes get_objects — briefing generators, ship checkers, PR annotators — needs this path. Mis-parsing surfaces as "why is every title undefined" not as an error.',
		metadata: {
			format_version: 'v1',
			doc_type: 'reference',
			tags: [
				'topic:mcp',
				'topic:maskin-mcp',
				'topic:agent-runtime',
				'senior-developer',
				'agent-pipeline',
			],
			scope: 'workspace',
			summary:
				'get_objects returns fields at result.object — accessing top-level .title reads undefined.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a25-dry-check-mandatory',
		title:
			'DRY check is a mandatory pre-build step — search for overlapping modules before writing',
		body: '## Rule\nBefore writing anything substantial, search the repo for modules, components, hooks, or utilities that overlap. If you find one, use or extend it and log what you found in your approach comment.\n\n## Why mandatory\nSkipping this is a blocking review failure. Duplicated logic is corrosive — the copy diverges, callers fragment, and the next agent has to guess which one is canonical.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:agent-pipeline',
				'topic:dry',
				'senior-developer',
				'code-reviewer',
				'code-review-pattern',
			],
			scope: 'workspace',
			summary:
				'DRY check before writing is mandatory — search for overlapping modules, extend not duplicate; skipping fails review.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a26-analytics-events-in-dod',
		title: 'Analytics instrumentation is part of the DoD when the bet names events to fire',
		body: '## Rule\nWhen the parent bet names analytics events — via `metadata.posthog_query` or the Validation sources it references — emitting those events against the connected analytics source is part of the task DoD, not a follow-up. Verify they fire before moving to in_review.\n\n## Deferral clause\nIf instrumentation must be deferred (missing surface, upstream schema not agreed), name the owning task in Ship Notes so the reviewer sees the trace instead of merging silently.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:agent-pipeline',
				'topic:analytics',
				'topic:posthog',
				'senior-developer',
				'code-reviewer',
			],
			scope: 'workspace',
			summary:
				'Analytics events named by the bet are part of the task DoD — emit and verify before in_review, or name the owner in Ship Notes.',
			confidence: 'medium',
		},
	},
	{
		fixtureId: 'a27-tests-ship-with-feature',
		title: 'Tests ship with the feature — one per DoD criterion, not a later cleanup task',
		body: '## Rule\nTests are not a follow-up. Every DoD criterion ships with a matching test in the same PR. A PR that satisfies the DoD in code but leaves the tests for "later" is not shippable — the Code Reviewer will bounce it.\n\n## Practical shape\nUnit test for pure logic; integration test for DB semantics; E2E spec for user-visible frontend. One per DoD criterion — do not batch coverage into a single sprawling test.',
		metadata: {
			format_version: 'v1',
			doc_type: 'playbook',
			tags: ['topic:testing', 'topic:agent-pipeline', 'senior-developer', 'code-reviewer'],
			scope: 'workspace',
			summary:
				'Tests ship with the feature — one per DoD criterion, in the same PR, never deferred.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a28-frontend-parity-real-browser',
		title:
			'Frontend parity means driving the surface in a real browser — mocked dnd/pointer/scroll does not count',
		body: '## Rule\nAny UI task, or any diff that touches interaction handlers, gets frontend-parity: render and drive the surface in a real browser. Mocked drag-and-drop, mocked pointer events, mocked scroll — none of those count as parity evidence.\n\n## Smoke-render floor\nEven when no prototype exists, every user-facing surface gets at least a smoke-render check in a real browser to catch regressions the type checker misses.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:frontend',
				'topic:testing',
				'topic:agent-pipeline',
				'senior-developer',
				'code-reviewer',
			],
			scope: 'product-area',
			summary:
				'Frontend parity requires a real-browser drive — mocked drag/pointer/scroll tests do not satisfy it. Smoke-render is the floor.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a29-push-rejected-fallback-branch',
		title:
			'When a push is rejected (branch protection / 403 / 422), push to a fallback branch and comment the SHA',
		body: '## Rule\nDo not discard work when a push is rejected. Do not wait. Push to a fallback branch (`bet/[slug]-wip` or `task/[id]-[short]`), then comment on the task with the fallback branch, the SHA, the literal error, and what a human needs to do to land it. Alert via slack-writer.\n\n## Why\nLosing work to a protected branch is the only real failure mode in this pipeline. Everything else has an unblock; this one destroys evidence unless you preserve the SHA on a fallback branch.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:agent-pipeline',
				'topic:git',
				'topic:branch-protection',
				'senior-developer',
				'pipeline-orchestration',
			],
			scope: 'workspace',
			summary:
				'On push rejection, fall back to bet-wip / task branch, comment the SHA + literal error, alert via slack — never discard the work.',
			confidence: 'high',
		},
	},
	{
		fixtureId: 'a30-review-cap-3-rounds',
		title: 'The /review self-check is capped at 3 rounds — if findings remain, hand off anyway',
		body: '## Rule\nWhen the /review multi-agent self-check runs on a high-risk diff, cap it at 3 rounds. If critical or important findings remain after 3 rounds, stop iterating — append the open items to Ship Notes, hand off to in_review anyway, and @mention the Code Reviewer with what is open.\n\n## Why the cap\nThe Code Reviewer is the backstop. Round-4 self-fixes tend to introduce new regressions faster than they close old findings, and the review loop starves. A 3-round cap forces a legible handoff instead.',
		metadata: {
			format_version: 'v1',
			doc_type: 'operational',
			tags: [
				'topic:agent-pipeline',
				'topic:code-review',
				'senior-developer',
				'code-reviewer',
				'code-review-pattern',
			],
			scope: 'workspace',
			summary:
				'Cap /review self-check at 3 rounds — after that, append open findings to Ship Notes and hand off to the Code Reviewer.',
			confidence: 'high',
		},
	},
	// Five deliberately non-v1 rows — mirroring the 90% non-v1 shape T6
	// flagged in the real corpus. These will not surface via T5's router
	// filter, so the router-regime retrieval accuracy on pairs that hit
	// them is expected to be 0 unless T10 relaxes the filter. That is the
	// point — the harness surfaces the gap.
	{
		fixtureId: 'a31-mention-humans-when-needed',
		body: "Mention humans whenever their input, decision, or attention would actually unblock work. The pipeline should never wait on a signal it never asked for. Don't mention humans gratuitously — but don't hesitate to mention Sebastian or Magnus when their input closes a real gap. @mentioning creates a needs_input notification the human sees on their next glance at the workspace.",
		title: 'Mention humans when their input would unblock — not gratuitously, not never',
		metadata: {
			tags: ['agent-pipeline', 'communication'],
			summary: 'Mention humans when their input would unblock. Do not sit on a signal you needed.',
		},
	},
	{
		fixtureId: 'a32-skills-load-only-on-trigger',
		title: 'Skills load only when the trigger hits — do not preload from the pipeline briefing',
		body: 'Skills in this workspace are opt-in per-trigger. spec-brief, consult-knowledge, ship, frontend-parity — each has a trigger condition described in the pipeline briefing. Load a skill only when its trigger fires. Loading skills eagerly bloats the context window and slows the session for no benefit; the briefing already names when each skill is expected.',
		metadata: {
			tags: ['agent-pipeline', 'skills', 'context-engineering'],
		},
	},
	{
		fixtureId: 'a33-knowledge-nudges-pattern',
		title:
			'KNOWLEDGE_NUDGES: when a user validates a non-obvious convention, write it as knowledge',
		body: 'The KNOWLEDGE_NUDGES prompt hook injects two lines into eight dev agents in this pipeline. It fires the write-side of the knowledge loop: whenever a user validates a non-obvious convention or preference in-conversation, the agent calls create_objects({ type: "knowledge" }) with a short title + body + tags. The nudge is deliberately narrow — it does not tell agents to write knowledge from their own reasoning; it triggers only on validated conventions.',
		metadata: {
			tags: 'agent-pipeline,knowledge,write-side',
			doc_type: 'operational',
		},
	},
	{
		fixtureId: 'a34-single-writer-per-file',
		body: 'Single-writer-per-file: when multiple agents may touch the same module in a shared branch, one agent owns the file and the others import from it. Forking the file (copy-paste + edit in a sibling) is the failure mode — the two copies drift and downstream reviewers cannot tell which is canonical. If you need to extend a shared module, extend it in place, or add a companion file that imports from it. Never fork.',
		title:
			'Single-writer-per-file — do not fork a shared module; extend in place or add a companion',
		metadata: {
			tags: ['senior-developer', 'code-review-pattern', 'agent-pipeline'],
		},
	},
	{
		fixtureId: 'a35-driver-handoff-mention',
		title: 'Driver handoff — flip the driver and @mention the next actor with a clear brief',
		body: 'When work continues to the next actor, flip the driver on the task and @mention the next actor in the same comment. The @mention creates a needs_input notification and (for agents) spawns a session that reads the comment and acts. Handoffs that only flip the driver — without a brief — leave the next actor guessing.',
		metadata: {
			tags: ['agent-pipeline', 'handoff', 'pipeline-orchestration'],
		},
	},
]

export const REPRESENTATIVE_PAIRS: readonly RepresentativePair[] = [
	{
		question:
			'A DB trigger builds a NOTIFY payload from a free-text column — what silently breaks?',
		expectedFixtureId: 'a01-pg-notify-8kb-limit',
		expectedExcerpt: 'silently rolls back',
	},
	{
		question:
			'An env var key comes from user input and is interpolated into an export command — what should we do first?',
		expectedFixtureId: 'a02-shell-injection-env-key',
		expectedExcerpt: '[A-Za-z_][A-Za-z0-9_]*',
	},
	{
		question:
			'A route reads req.query.limit with Number(); the SQL returns nothing on some requests. What is the fix pattern?',
		expectedFixtureId: 'a03-numeric-parsing-nan',
		expectedExcerpt: 'Number.isFinite',
	},
	{
		question:
			'A designer added a small colored dot to signal unread items — it looks fine in dark mode but nobody sees it in light mode. What went wrong?',
		expectedFixtureId: 'a04-accent-token-invisible-light-mode',
		expectedExcerpt: 'near-invisible',
	},
	{
		question:
			'Our per-row COUNT subquery in a Drizzle sql template always returns 0 — what is the rendering bug?',
		expectedFixtureId: 'a05-drizzle-correlated-subquery-unqualified',
		expectedExcerpt: 'unqualified',
	},
	{
		question:
			'A service method updates integrations.status but the audit trail and realtime feed never see the change. What did we forget?',
		expectedFixtureId: 'a06-missing-events-audit-log',
		expectedExcerpt: 'db.insert(events)',
	},
	{
		question:
			'The GitHub MCP server started returning 403s on every call — the token is set as GITHUB_TOKEN in the env object. What is wrong?',
		expectedFixtureId: 'a07-github-mcp-env-key',
		expectedExcerpt: 'GITHUB_PERSONAL_ACCESS_TOKEN',
	},
	{
		question:
			'I need a new UI element that looks close to an existing one — should I create a new component?',
		expectedFixtureId: 'a08-dry-component-reuse',
		expectedExcerpt: 'exhaust every existing option',
	},
	{
		question:
			'I want to customise a shadcn Button with a taller height and thicker border — is that OK?',
		expectedFixtureId: 'a09-shadcn-plain-as-is',
		expectedExcerpt: 'Use them plain',
	},
	{
		question: 'At which specific viewport widths must every frontend surface work?',
		expectedFixtureId: 'a10-responsive-ship-gate-viewports',
		expectedExcerpt: '375px',
	},
	{
		question:
			'A PR adds a new column and a write route — what kind of test does it need before ship?',
		expectedFixtureId: 'a11-integration-test-required-db-changes',
		expectedExcerpt: 'integration test',
	},
	{
		question:
			'A PR modifies a user-visible page. Beyond unit tests, what runtime verification is required?',
		expectedFixtureId: 'a12-e2e-spec-required-frontend-changes',
		expectedExcerpt: 'Playwright spec',
	},
	{
		question:
			'A reviewer says my mocked-db unit test covers the ON CONFLICT branch — should I trust that?',
		expectedFixtureId: 'a13-mock-db-tests-cannot-catch-db-semantics',
		expectedExcerpt: 'cannot substitute',
	},
	{
		question:
			'I am adding Google Calendar integration — Google runs an MCP server; should I still write a custom in-process route?',
		expectedFixtureId: 'a14-hosted-mcp-before-custom',
		expectedExcerpt: 'mcp-remote',
	},
	{
		question:
			'I added a new API key env var but the running service reads it as undefined — where should I look?',
		expectedFixtureId: 'a15-turbo-globalpassthroughenv',
		expectedExcerpt: 'globalPassThroughEnv',
	},
	{
		question:
			'A reviewer flagged that a header-scoped route is missing an isWorkspaceMember check — is that a real bug?',
		expectedFixtureId: 'a16-x-workspace-id-header-auth',
		expectedExcerpt: 'authMiddleware',
	},
	{
		question:
			'Should this bet move to active now that Phase 0 tasks are queued, or should it wait for the harness?',
		expectedFixtureId: 'a17-bet-define-until-agreed',
		expectedExcerpt: 'define until',
	},
	{
		question:
			'Should we build out format spec, ingest automation, and retrieval infra in parallel across three domains — or take one domain end to end first?',
		expectedFixtureId: 'a18-bet-vertical-slice',
		expectedExcerpt: 'Vertical slice',
	},
	{
		question:
			'A task is going to run out of time and I have not finished — is it OK to let the session end quietly?',
		expectedFixtureId: 'a19-never-pause-silently',
		expectedExcerpt: 'leave a comment',
	},
	{
		question:
			"A predecessor PR has not merged yet — should I mark my follow-on task 'blocked' and wait?",
		expectedFixtureId: 'a20-nothing-blocked-invariant',
		expectedExcerpt: 'No blocked status exists',
	},
	{
		question: 'The bet PR is green — should the Senior Developer press Merge?',
		expectedFixtureId: 'a21-you-never-merge',
		expectedExcerpt: 'Code Reviewer owns the merge',
	},
	{
		question:
			"Am I allowed to write 'ran Step 7 and passed ship' in a PR description or Ship Notes?",
		expectedFixtureId: 'a22-plain-language-only',
		expectedExcerpt: 'internal scaffolding',
	},
	{
		question:
			'Where should I clone the repo when starting a task — the default /tmp or somewhere else?',
		expectedFixtureId: 'a23-clone-agent-workspace-not-tmp',
		expectedExcerpt: '/agent/workspace',
	},
	{
		question:
			'get_objects returns undefined for every object title in my agent script. What path am I missing?',
		expectedFixtureId: 'a24-get-objects-parsing',
		expectedExcerpt: 'result.object',
	},
	{
		question:
			'Do I need to check for existing modules that already do something similar before I start writing?',
		expectedFixtureId: 'a25-dry-check-mandatory',
		expectedExcerpt: 'blocking review failure',
	},
	{
		question:
			'The bet lists PostHog events under metadata.posthog_query — is emitting them part of my task DoD or a follow-up?',
		expectedFixtureId: 'a26-analytics-events-in-dod',
		expectedExcerpt: 'part of the task DoD',
	},
	{
		question:
			'Can I ship a feature PR now and add the tests in a follow-up PR next week? The Reviewer will still merge, right?',
		expectedFixtureId: 'a27-tests-ship-with-feature',
		expectedExcerpt: 'Tests ship with the feature',
	},
	{
		question:
			'I wrote a Playwright test that mocks drag-and-drop instead of driving it in a browser — does that satisfy frontend-parity?',
		expectedFixtureId: 'a28-frontend-parity-real-browser',
		expectedExcerpt: 'none of those count as parity evidence',
	},
	{
		question:
			'My push to the bet branch was rejected by branch protection — should I discard the work or wait for the human?',
		expectedFixtureId: 'a29-push-rejected-fallback-branch',
		expectedExcerpt: 'fallback',
	},
	{
		question:
			"I've run /review three times, still one important finding open — should I keep iterating or hand off?",
		expectedFixtureId: 'a30-review-cap-3-rounds',
		expectedExcerpt: 'Ship Notes',
	},
]

if (REPRESENTATIVE_CORPUS.length !== 35) {
	throw new Error(
		`REPRESENTATIVE_CORPUS must have 35 entries (has ${REPRESENTATIVE_CORPUS.length}).`,
	)
}

if (REPRESENTATIVE_PAIRS.length < 30) {
	throw new Error(
		`REPRESENTATIVE_PAIRS must have at least 30 entries (has ${REPRESENTATIVE_PAIRS.length}).`,
	)
}

const IDS = new Set(REPRESENTATIVE_CORPUS.map((row) => row.fixtureId))
if (IDS.size !== REPRESENTATIVE_CORPUS.length) {
	throw new Error('REPRESENTATIVE_CORPUS fixtureIds must be unique.')
}
for (const pair of REPRESENTATIVE_PAIRS) {
	if (!IDS.has(pair.expectedFixtureId)) {
		throw new Error(
			`REPRESENTATIVE_PAIRS references fixtureId ${pair.expectedFixtureId} which is not in REPRESENTATIVE_CORPUS.`,
		)
	}
}

// Excerpt must be present in title or body of its gold row — otherwise the
// grader can never score the pair correct and the harness silently biases
// low.
const BY_ID = new Map(REPRESENTATIVE_CORPUS.map((row) => [row.fixtureId, row]))
const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
for (const pair of REPRESENTATIVE_PAIRS) {
	const row = BY_ID.get(pair.expectedFixtureId)
	if (!row) continue
	const source = normalise(`${row.title}\n${row.body}`)
	if (!source.includes(normalise(pair.expectedExcerpt))) {
		throw new Error(
			`REPRESENTATIVE_PAIRS excerpt not found in gold row: ${pair.expectedFixtureId} :: ${pair.expectedExcerpt}`,
		)
	}
}
