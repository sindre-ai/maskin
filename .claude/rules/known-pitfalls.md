# Known Pitfalls Registry

A living registry of bugs that have been fixed before and should be checked for in new code. Before submitting a PR, review this list for any patterns that match your changes.

## PG NOTIFY Payload Size (8KB Limit)

- **What**: `pg_notify()` silently fails — it rolls back the triggering INSERT — if the payload exceeds 8KB. There is no warning or error; the row simply doesn't get inserted.
- **When to check**: Any time you write or modify a DB trigger that uses `pg_notify()`.
- **Fix pattern**: Truncate or omit large fields (especially `content`, `description`, or any free-text column) before including them in the notification payload. See migration `0006_notify_drop_data.sql` for the established pattern.
- **History**: Originally fixed for the `events` table in migration `0006_notify_drop_data.sql`. Re-introduced for `session_logs` in PR #224 (migration `0008_session_logs_notify.sql`), which added `left(NEW.content, 7000)` to stay under the limit. That PR's line of history is not an ancestor of the current `main` — the codebase was later restructured onto the in-process `EventEmitter` approach for session-log SSE (`session-manager.ts`'s `emit('log', ...)`), but the `session_logs_notify` trigger was never dropped from the live database, so it kept running in production, orphaned. Its character-based truncation (not byte-based) still let multi-byte UTF-8 content push the payload over 8KB, silently dropping `session_logs` inserts (Sentry `MASKIN-DEV-5` / `MASKIN-AGENT-SERVER-1`, 2026-08-11/12). Fixed by dropping the trigger entirely in `0052_drop_orphaned_session_logs_notify.sql`, since nothing in the current codebase listens on the `session_logs` NOTIFY channel — only `'events'` is consumed (`packages/realtime/src/notify.ts`). **Takeaway: if a feature that owns a DB trigger is replaced, the trigger must be dropped in an explicit migration — a code-only rewrite (e.g. a history restructure or squash) won't remove it from a live database.**

## Shell Injection via String Interpolation

- **What**: Interpolating untrusted strings into shell commands allows command injection. An attacker-controlled value in an `export` statement, `exec()` call, or template literal that becomes shell input can execute arbitrary commands.
- **When to check**: Any time you construct shell commands from variables — `export` statements, `exec()` calls, `spawn()` with `shell: true`, or template literals that become shell input.
- **Fix pattern**: Validate input against a strict allowlist regex before interpolation. For env var keys, use `[A-Za-z_][A-Za-z0-9_]*`. Prefer parameterized APIs (e.g., `spawn(cmd, args)` without `shell: true`) over string interpolation. See `.claude/rules/input-validation.md` for the full checklist.
- **History**: Shell injection via env var key interpolation in `buildEnvExports()`, fixed in PR #230.

## Numeric Parameter Parsing (NaN Propagation)

- **What**: `Number()` returns `NaN` for non-numeric strings, and `NaN` propagates silently through arithmetic. When passed to a SQL query, it produces unexpected results or errors without any validation failure at the parsing step.
- **When to check**: Any HTTP query parameter, path parameter, or config value parsed as a number.
- **Fix pattern**: Always check `Number.isFinite()` after parsing and fall back to a sensible default. Also validate range (e.g., no negative values for pagination `limit` or `offset`). See `.claude/rules/input-validation.md` for the safe parsing pattern.
- **History**: `NaN` propagation to SQL query in `GET /sessions` route, fixed in PR #235.

## `accent` Token Used Without Its Foreground Pair (Invisible in Light Mode)

`--accent` is a near-white background token in light mode. Using it as a standalone visible color (text, dot, or rail) produces near-invisible output on white surfaces.

**Variant A — `text-accent` as a text color**
- **What**: Text rendered with `text-accent` is nearly invisible in light mode.
- **When to check**: Any time you add a styled text button or inline action element.
- **Fix pattern**: Use `text-muted-foreground hover:text-foreground` for inline action buttons.
- **History**: Introduced on Restart/Retry buttons in PR #503, fixed on `bet/session-restart`.

**Variant B — `bg-accent` on a text-free indicator (dot, rail, badge background)**
- **What**: `bg-accent` on a small shape (unread dot, gutter rail, status indicator) with no accompanying text looks correct in dark mode but is near-invisible in light mode. Unlike a labelled pill, there is no `text-accent-foreground` child to catch the problem.
- **When to check**: Any time you add a purely visual indicator — a dot, a stripe, a pill background, a left-border rail — that carries no text content.
- **Fix pattern**: Use `bg-primary` for indicators that must be visually prominent in both modes. Reserve `bg-accent` for backgrounds that are always paired with `text-accent-foreground` (e.g. the "Needs you" pill: `bg-accent text-accent-foreground`).
- **History**: Introduced on unread dot and decision-point gutter rail in PR #622, fixed in the review commit on `bet/timeline-ux`.

## Drizzle Column Objects in a Correlated `sql` Subquery Render Unqualified

- **What**: Embedding Drizzle column objects (e.g. `${sessions.agentServerId}`, `${agentServers.id}`) inside a raw `` sql`` `` template that builds a **correlated subquery** renders them **without a table qualifier** — `WHERE agent_server_id = id` instead of `WHERE sessions.agent_server_id = agent_servers.id`. When the inner table also has a column of that bare name (here `sessions.id`), Postgres silently binds it to the *inner* table, so the correlation is never true and the aggregate (`COUNT(*)`, `SUM`, …) is always `0`/empty. No error is raised — the query just returns wrong numbers.
- **When to check**: Any correlated scalar subquery written inside a Drizzle `` sql`` `` template — especially a per-row `COUNT`/`SUM` that references both the outer and inner tables (load counters, capacity checks, "active children" tallies). Unit tests that mock `db.select` will NOT catch this; only a real-Postgres (integration) test does.
- **Fix pattern**: Write the correlated columns as **literal, table-qualified SQL** inside the template — `` sql`... WHERE sessions.agent_server_id = agent_servers.id ...` `` — instead of interpolating Drizzle column objects. Or use a `LEFT JOIN LATERAL` with explicit aliases (the shape documented in migration `0036_sessions_agent_server_id.sql`). Cover it with an integration test against a real DB, not a mocked one — see `apps/dev/src/__tests__/integration/session-dispatcher.test.ts`.
- **History**: `SessionDispatcher.pickLeastLoadedServer()` in PR #714 — the active-session load count rendered `WHERE agent_server_id = id`, so every agent-server read as load 0: capacity (`active >= max`) was never enforced and least-loaded routing collapsed to the lowest server id, defeating the bet's horizontal scaling. Caught by a real-Postgres dispatch test, not the mocked unit tests.

## Missing Events Audit Log on Entity Mutations

- **What**: The CLAUDE.md rule states "Events logged on every mutation (create/update/delete) for audit + real-time." Omitting the `events` insert is a silent failure — the mutation succeeds, no error is raised, but the audit trail is broken and SSE-based real-time invalidation never fires for that change.
- **When to check**: Any time you write a `db.update()` or `db.insert()` against a first-class entity table (`integrations`, `sessions`, `objects`, `triggers`, `workspaces`, `actors`). Also check any helper or service method that wraps a mutation (e.g. `markRevoked`, `updateStatus`) — these are easy to miss because the mutation is one level removed from the route handler.
- **Fix pattern**: Every mutation must be followed by a `db.insert(events).values({ workspaceId, actorId, action: 'created'|'updated'|'deleted', entityType, entityId, data: {...changed fields} })`. For service-layer methods that don't have direct access to `actorId`, query the entity row first to get `createdBy` and `workspaceId`, then insert the event. See `TokenManager.markRevoked()` in `apps/dev/src/lib/integrations/oauth/token-manager.ts` for the established pattern.
- **History**: `TokenManager.markRevoked()` in PR #879 updated `integrations.status` to `'revoked'` without inserting an events row, silently breaking the audit trail and real-time feed for revocation events. Fixed in the post-review commit on `task/t2-token-manager`.

## GitHub MCP Server Env Key Must Be `GITHUB_PERSONAL_ACCESS_TOKEN`, Not `GITHUB_TOKEN`

- **What**: `@modelcontextprotocol/server-github` reads its auth token exclusively from the `GITHUB_PERSONAL_ACCESS_TOKEN` env var. Passing the token under the key `GITHUB_TOKEN` in an MCP server's `env` object is silently ignored — no error, the subprocess just makes unauthenticated requests, which surface later as 403 / rate-limit-shaped errors on every GitHub tool call (read, review, merge). This is distinct from the *container-level* env var also named `GITHUB_TOKEN` (set by `session-manager.ts` and consumed by `envsubst`/the `gh` CLI) — that one is fine to keep as `GITHUB_TOKEN`. The bug is specifically the **object key** inside `env: { ... }` on a `@modelcontextprotocol/server-github` MCP server entry — that key is what gets handed to the subprocess as an environment variable name.
- **When to check**: Any time you add or edit a `github` MCP server entry — an `env: { <KEY>: '${...}' }` block whose `args` include `@modelcontextprotocol/server-github` — in an agent template, seed data, or the frontend "Add GitHub" quick-add.
- **Fix pattern**: The env object key must be `GITHUB_PERSONAL_ACCESS_TOKEN`. The value (the `${GITHUB_TOKEN}` / `${GITHUB_TOKEN_<OWNER>}` placeholder, or the literal token) is unaffected — only the key changes. See `packages/shared/src/templates/development-agents.ts` (`githubTool`/`githubPlusMaskinTools`), `apps/web/src/components/agents/mcp-servers.tsx` (`handleAddGithub`), and `apps/dev/src/services/session-manager.ts` (auto-injected per-org `github-<owner>` MCP entries) for the corrected pattern.
- **History**: All four GitHub-identity MCP servers (`github`, `github_approver`, `github-sindre-ai`, `github-vaerksted-ai`) used by the Code Reviewer agent were misconfigured with `GITHUB_TOKEN` as the env key, blocking auto-merge on every PR until the live agent configs were corrected. Root-caused and fixed in code across `packages/db/src/seed.ts`, `packages/shared/src/templates/development-agents.ts`, `apps/web/src/components/agents/mcp-servers.tsx`, and `apps/dev/src/services/session-manager.ts` so new agents and new GitHub integrations don't reintroduce it.

## New Workspace Package Missing from `apps/dev/Dockerfile` COPY List

- **What**: `apps/dev/Dockerfile` copies each workspace package's `package.json` individually (one `COPY packages/<name>/package.json packages/<name>/package.json` line per package) *before* `RUN pnpm install --frozen-lockfile`, so Docker can cache the install layer. If a new package under `packages/` is added but its `package.json` COPY line is not added to this list, `pnpm install` never sees that package and never installs its dependencies. The later `COPY packages/ packages/` still copies the package's source, so the build proceeds into `pnpm --filter='./packages/*' build` and fails with `tsc` errors like `error TS2307: Cannot find module '<dep>'` for every dependency of the new package — plus a telling `WARN Local package.json exists, but node_modules missing, did you mean to install?`. This is a 100%-reproducible build failure on every subsequent commit to `main` until fixed — not a flaky or code-specific bug — because it breaks at the Docker layer-caching step, unrelated to what the commit itself changes.
- **When to check**: Any time you add a new package directory under `packages/` (i.e., add an entry that will match the `./packages/*` pnpm filter). Before merging, confirm `apps/dev/Dockerfile` has a `COPY packages/<name>/package.json packages/<name>/package.json` line for it, alongside the other `packages/*/package.json` COPY lines (currently before line ~14, immediately above `RUN pnpm install --frozen-lockfile`).
- **Fix pattern**: Add the missing `COPY packages/<name>/package.json packages/<name>/package.json` line to `apps/dev/Dockerfile`, grouped with the other package `COPY` lines, before the `pnpm install --frozen-lockfile` step.
- **History**: First occurred for `packages/risk-classifier`, fixed in commit `8e1c2d96` ("Fix prod Docker build: missing risk-classifier package.json COPY"). Recurred for `packages/markdown`, introduced in commit `9590e08f` (2026-07-19) and left every subsequent deploy to `main` failing in Coolify for over two weeks (production served stale code from before that commit) until diagnosed and fixed on 2026-08-04.

## Runtime File Reads Relative to `import.meta.url` Break Under esbuild Bundling

- **What**: `apps/dev/build.mjs` bundles the entire app into a single flat `dist/index.js` with esbuild (`bundle: true`). Code that computes a data-file path as `dirname(fileURLToPath(import.meta.url)) + '/some-dir'` — expecting the compiled file to still sit next to a checked-in folder — breaks silently at build time (no type error, no lint error, the build succeeds) because after bundling `import.meta.url` resolves to `dist/index.js`, not the source file's original location. The directory it looks for (e.g. `dist/data/`) never gets created by the build or the Dockerfile, so the first read throws `ENOENT` at runtime. Because the file is read at **module top-level** (not inside a function), the crash happens at import time — before the server even starts listening — so it takes down the whole process on boot.
- **When to check**: Any time you add `readFileSync`/`readdirSync` (or similar) using a path derived from `import.meta.url` or `__dirname` in code that lives under `apps/dev/src/` (or any other app built with `build.mjs`'s single-file esbuild bundle). This pattern is invisible in local dev (`pnpm dev` runs `tsx watch src/index.ts` unbundled, where the compiled-file-relative path is still correct) and invisible in CI's e2e/unit tests (they also run via `tsx`, never the built `dist/index.js`) — it only surfaces after a real deploy of the bundled artifact.
- **Fix pattern**: Prefer a static `import` of the data file (e.g. `import data from './data/foo.json'`, `resolveJsonModule` is already on in the root `tsconfig.json`) so esbuild inlines the content into the bundle at build time — this removes the runtime filesystem dependency entirely and can't break under bundling. If the data can't be a static import (e.g. it's not JSON, or it's genuinely meant to be swapped without a rebuild), copy it into `dist/` explicitly as a `build.mjs` post-build step and read it from a path derived the same way, or read it from `process.cwd()`-relative repo paths instead of `import.meta.url`. CI's `integration-tests` job now boots the actual `apps/dev/dist/index.js` bundle and polls `/api/health` before running tests (see `.github/workflows/ci.yml`, step "Smoke test — boot the built server") — this catches import-time crashes like this one before merge, since it's the only CI job that runs the real bundled artifact instead of `tsx`.
- **History**: `apps/dev/src/lib/marketplace-loops/loop-data.ts` read `dev-actors.json`/`dev-triggers.json`/`dev-skills.json` this way; introduced in PR #1163 ("Rebuild catalog packages from live Development workspace data"), crashed every production boot with `ENOENT: .../dist/data/dev-actors.json` until fixed by switching to static JSON imports (2026-08-05).

## Adding New Entries

This file should be updated whenever a new recurring bug pattern is identified. Each entry must include:

1. **What** — describe the bug and why it is dangerous (silent failure, security risk, data corruption, etc.)
2. **When to check** — the specific trigger that should prompt you to look for this pattern
3. **Fix pattern** — the concrete fix, with a reference to existing code or rules that demonstrate it
4. **History** — which PR introduced and/or fixed the bug, so future developers can find the full context
