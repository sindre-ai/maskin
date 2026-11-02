# Known Pitfalls Registry

A living registry of bugs that have been fixed before and should be checked for in new code. Before submitting a PR, scan the **Check when** lines below for any that match your changes. If one does, **read its full entry** (linked) before writing the code — each holds the fix pattern and the history.

The full entries live in `docs/pitfalls/` and are deliberately not loaded into every session; this index is.

### PG NOTIFY Payload Size (8KB Limit)
**Check when:** Any time you write or modify a DB trigger that uses `pg_notify()`.
[Full entry](../../docs/pitfalls/pg-notify-payload-size.md)

### Shell Injection via String Interpolation
**Check when:** Any time you construct shell commands from variables — `export` statements, `exec()` calls, `spawn()` with `shell: true`, or template literals that become shell input.
[Full entry](../../docs/pitfalls/shell-injection.md)

### Numeric Parameter Parsing (NaN Propagation)
**Check when:** Any HTTP query parameter, path parameter, or config value parsed as a number.
[Full entry](../../docs/pitfalls/numeric-param-nan.md)

### `accent` Token Used Without Its Foreground Pair (Invisible in Light Mode)
**Check when:** Any time you use `text-accent` or `bg-accent` as a standalone visible colour — text buttons, dots, rails, badge backgrounds with no `text-accent-foreground` child.
[Full entry](../../docs/pitfalls/accent-token-foreground.md)

### Drizzle Column Objects in a Correlated `sql` Subquery Render Unqualified
**Check when:** Any correlated scalar subquery written inside a Drizzle `` sql`` `` template — especially a per-row `COUNT`/`SUM` that references both the outer and inner tables (load counters, capacity checks, "active children" tallies).
[Full entry](../../docs/pitfalls/drizzle-correlated-subquery.md)

### Missing Events Audit Log on Entity Mutations
**Check when:** Any time you write a `db.update()` or `db.insert()` against a first-class entity table (`integrations`, `sessions`, `objects`, `triggers`, `workspaces`, `actors`).
[Full entry](../../docs/pitfalls/missing-events-audit-log.md)

### GitHub MCP Server Env Key Must Be `GITHUB_PERSONAL_ACCESS_TOKEN`, Not `GITHUB_TOKEN`
**Check when:** Any time you add or edit a `github` MCP server entry — an `env: { <KEY>: '${...}' }` block whose `args` include `@modelcontextprotocol/server-github` — in an agent template, seed data, or the frontend "Add GitHub" quick-add.
[Full entry](../../docs/pitfalls/github-mcp-env-key.md)

### New Workspace Package Missing from `apps/dev/Dockerfile` COPY List
**Check when:** Any time you add a new package directory under `packages/` (i.e., add an entry that will match the `./packages/*` pnpm filter).
[Full entry](../../docs/pitfalls/dockerfile-package-copy.md)

### Runtime File Reads Relative to `import.meta.url` Break Under esbuild Bundling
**Check when:** Any time you add `readFileSync`/`readdirSync` (or similar) using a path derived from `import.meta.url` or `__dirname` in code that lives under `apps/dev/src/` (or any other app built with `build.mjs`'s single-file esbuild bundle).
[Full entry](../../docs/pitfalls/import-meta-url-esbuild.md)

### Agent Sandbox Sessions Can't Run `docker-compose` — Use `pnpm dev:no-docker`
**Check when:** Any time an agent session needs a live Postgres + S3-compatible stack for local verification (integration tests per `.claude/rules/verification.md`, manual UI checks, E2E specs) and `pnpm dev`/`pnpm dev:win` fails because Docker isn't available.
[Full entry](../../docs/pitfalls/sandbox-no-docker.md)

### Integration Test `global-setup.ts` Leaks a Connection Pool Per Test File (`sorry, too many clients already`)
**Check when:** Any time you add a second/independent DB client (or anything wrapping one, like `createDb()`) inside a Vitest `setupFiles` module — especially one with `beforeAll`/`afterAll` lifecycle hooks that are easy to assume run "once for the whole suite" when they actually run per test file.
[Full entry](../../docs/pitfalls/integration-test-pool-leak.md)

### Interactive Sessions Dispatched to a Remote Agent-Server Never Received Their First Turn
**Check when:** Any time a workflow has both a local (Docker/in-process) implementation and a remote (HTTP-dispatched) implementation of the same session/job lifecycle — especially a step that's easy to think of as "part of container startup" (like seeding a process's stdin) rather than a first-class, independently-dispatched action.
[Full entry](../../docs/pitfalls/remote-interactive-first-turn.md)

### The Remote Completion Path Skipped Classification and Failover Entirely
**Check when:** Any time you add a step to `handleCompletion()`, and any time a lifecycle has both a local (Docker/in-process) and a remote (HTTP-dispatched) implementation.
[Full entry](../../docs/pitfalls/remote-completion-path.md)

### Verifying Against Stale State — `dist/` Output and Uncommitted Files
**Check when:** After editing anything under `packages/` whose consumers are tested from `apps/`; before claiming a pushed branch is green; and any time you are verifying while part of the tree is intentionally uncommitted (parallel agents, split PRs, work owned by another session).
[Full entry](../../docs/pitfalls/stale-dist-uncommitted.md)

### A "Healthy" Collector Component That Silently Matches Nothing
**Check when:** Any change to an Alloy config, or a first install on a new host.
[Full entry](../../docs/pitfalls/alloy-silent-empty.md)

### A Grafana Alert Rule That Imports Cleanly and Then Says Nothing Useful
**Check when:** Any time you add or edit a file under `observability/*/alerts/`, or any Grafana alert rule defined as YAML rather than in the UI.
[Full entry](../../docs/pitfalls/grafana-alert-rules.md)

### A Frontend Observability SDK That Is Tree-Shaken Out of the Production Bundle
**Check when:** Any time you add or rely on a `VITE_`-gated SDK, and *specifically* whenever you add a `VITE_` var.
[Full entry](../../docs/pitfalls/faro-tree-shaken.md)

### A Build Plugin Whose Transitive Dep Outranks the Builder's Node Version
**Check when:** Any time you add a plugin to `vite.config.ts` (or any build config).
[Full entry](../../docs/pitfalls/vite-plugin-node-engines.md)

### An MCP Tool Whose Two Response Channels Carry Different Payloads
**Check when:** Any time you add or edit a tool in `packages/mcp/src/server.ts` that returns both `content` and `structuredContent`, and any time you add a `heroCard` (or other presentation projection) to a tool's response.
[Full entry](../../docs/pitfalls/mcp-dual-channel-payload.md)

### A Successful Turn Whose "Reply" Is the Model Narrating Tool Calls It Never Made
**Check when:** Any code path that takes model-authored text and puts it in front of a human without a schema between them — the interactive chat finalizer, comment bodies, PR descriptions, anything posted from a `result` envelope.
[Full entry](../../docs/pitfalls/pseudo-tool-call-reply.md)

### An OAuth Scope Requested in Code but Not Declared in the Provider's App Manifest
**Check when:** Any time you add, rename or remove an entry in a provider config's `scopes` array or `extraAuthParams.user_scope`.
[Full entry](../../docs/pitfalls/oauth-scope-manifest.md)

### A Provider Route That Exists in the API but Not for the Provider You Called It With (501)
**Check when:** Any time you add or edit a Unipile v2 call in `providers/linkedin-unipile/unipile-client.ts`, and any time you copy a path from a Unipile reference page — check whether an inbox-scoped or otherwise provider-scoped variant of that endpoint exists, and prefer it for LinkedIn.
[Full entry](../../docs/pitfalls/unipile-501-route.md)

### A Field Written to `workspaces.settings` but Not Modelled in the Strict Settings Schema
**Check when:** Any time you persist a new key into `workspaces.settings` — including a new field inside an existing sub-object like `claude_oauth`, `billing`, or `custom_llm`, and including one written by a route that (correctly) bypasses `PATCH /api/workspaces`.
[Full entry](../../docs/pitfalls/workspace-settings-strict-schema.md)

### A Non-Token Field on a Record That Some Writer Rebuilds From Scratch
**Check when:** Any time you add a field to a record that is persisted as one blob, and any time you write such a blob from a function whose job is only one of the fields.
[Full entry](../../docs/pitfalls/blob-field-rebuilt-by-writer.md)

### Auto-Inject MCP Registered but Never Reaches a Session (Token Resolution Short-Circuit)
**Check when:** Any time you add a new provider with `mcp.autoInject: true`, and any time you edit `SessionManager.buildLaunchSpec`'s active-integrations loop.
[Full entry](../../docs/pitfalls/autoinject-mcp-token-short-circuit.md)

### A Re-Entrancy Flag With No Timeout Turns One Hung Await Into a Global Outage
**Check when:** Any in-process worker loop (`setInterval` + a `running`/`busy` flag, a single-flight mutex, a serial job runner) whose body awaits I/O — DB, HTTP, S3.
[Full entry](../../docs/pitfalls/reentrancy-flag-no-timeout.md)

### A Per-Session Lifecycle Signal Driving Something That Is Really Per-Turn
**Check when:** Any feature that shows progress or presence for an agent and is driven by `events` rows with `entity_type: 'session'`, or by `sessions.status`.
[Full entry](../../docs/pitfalls/per-session-vs-per-turn-signal.md)

### A Bare `return` in a Shell Function Under `set -e` Aborts the Whole Script Silently
**Check when:** Any new or edited function in `docker/agent-base/*.sh`, or any `set -e` script, with an early exit for an optional feature (`[ … ] || return`) or an `&&` list as its last statement.
[Full entry](../../docs/pitfalls/shell-bare-return-set-e.md)

### A Per-Provider Cleanup That Matches Every Credential of a Multi-Identity Provider
**Check when:** Any cleanup, sync or reconciliation that matches agent config (`actors.tools.mcpServers`) by URL or name, for a provider whose `identityFanout` is `per-identity` or `per-installation` (LinkedIn today; GitHub's per-installation entries are the next candidate).
[Full entry](../../docs/pitfalls/per-provider-cleanup-multi-identity.md)

## Adding New Entries

Add the full entry as `docs/pitfalls/<slug>.md` and a matching index block above (title, one-sentence **Check when**, link). Keep the index line to one sentence — detail belongs in the full entry. Each full entry must include:

1. **What** — describe the bug and why it is dangerous (silent failure, security risk, data corruption, etc.)
2. **When to check** — the specific trigger that should prompt you to look for this pattern
3. **Fix pattern** — the concrete fix, with a reference to existing code or rules that demonstrate it
4. **History** — which PR introduced and/or fixed the bug, so future developers can find the full context
