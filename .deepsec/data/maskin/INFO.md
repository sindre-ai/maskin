# Maskin — repo context for DeepSec

Repo: `sindre-ai/maskin` — Turborepo + pnpm monorepo. Backend `apps/dev` (Hono + Drizzle + Postgres), frontend `apps/web` (Vite + React + TanStack), MCP server `packages/mcp`, agent execution via Docker containers driven by `apps/dev/src/services/session-manager.ts`.

Two things you actually need to review well against this codebase: how workspace scoping is enforced, and which review patterns are known false positives.

## Auth and workspace scoping (the real model)

Every write endpoint and every workspace-scoped read is guarded by `authMiddleware` (`packages/auth/src/middleware.ts`). It runs on the whole `/api` router before any route handler and does two things in order:

1. **Bearer API-key check.** `Authorization: Bearer ank_…` — `validateApiKey()` resolves it to an `actorId` + `actorType` and puts them on the request context (`c.set('actorId', …)`). Non-`ank_` tokens are rejected with 401. `apps/dev/src/routes/actors.ts` is the only route that mints keys.
2. **Workspace-membership check when `X-Workspace-Id` is present.** If the request carries the header, the middleware queries `workspace_members` for `(actorId, workspaceId)` and returns **404 "Workspace not found"** if the row is missing. This is deliberate — 404, not 403, so an attacker can't probe workspace ids.

Routes then use one of two patterns depending on where the workspace comes from:

- **Header-scoped routes** (list, create, and anything else that reads `X-Workspace-Id`) — the middleware has already enforced membership. The handler pulls `workspaceId` from the validated header and uses it directly in `WHERE workspace_id = $1` predicates. **These handlers do not, and should not, call `isWorkspaceMember` a second time.**
- **By-ID routes** (`GET/PATCH/DELETE /:id` where the workspace is derived from the resource itself, not the header) — the handler loads the row first, then checks `await isWorkspaceMember(db, actorId, existing.workspaceId)` from `apps/dev/src/lib/workspace-auth.ts`. If either the row is missing or the caller is not a member, it returns 404. This is the second layer and is required, because `X-Workspace-Id` is not part of the by-ID contract.

`isWorkspaceOwner` and `isWorkspaceHumanAdminOrOwner` (same file) are stricter variants for owner-only surfaces and for surfaces where only workspace humans (never agents) can act — e.g. Knowledge Author's "verified by human" stamp. Missing use of these on a human-only surface is a real bug worth flagging.

## Threat model (from `SECURITY.md` and the recurring miss pattern)

In scope for review:

- Backend API in `apps/dev` — cross-workspace data disclosure and cross-workspace writes are the highest-priority class.
- Auth + workspace membership + role checks (`packages/auth/**`, `apps/dev/src/lib/workspace-auth.ts`, `apps/dev/src/routes/actors.ts`).
- Agent session isolation and container security — `apps/dev/src/services/session-manager.ts`, `apps/dev/src/services/container-manager.ts`, `docker/`. Specifically: unbounded / attacker-supplied `base_image`, host-side `tar` extraction of session snapshots, and TOCTOU on `hasCapacity()` counters have been real findings — treat them as in-scope.
- MCP server (`packages/mcp`) and integration OAuth/webhooks (`apps/dev/src/lib/integrations/oauth/**`, `.../webhooks/**`) — token handling, secret env-var handling, `envsubst` blast radius on user-authored MCP JSON.
- Data access controls: any `db.select().from(…).where(inArray(…))` that batch-fetches a collection of ids **must** predicate on `workspace_id` too. Batch reads of `relationships`, `objects`, `files` etc. across a set of ids without a workspace filter is the recurring class this project has shipped several times — always worth flagging.
- Any DB trigger that calls `pg_notify()` with free-text columns → 8 KB payload limit, silent INSERT rollback. See `packages/db/drizzle/0006_notify_drop_data.sql` for the established truncation pattern.
- Shell construction: `envsubst`, `spawn(cmd, {shell:true})`, template-literal `exec`, `export KEY=VAL` builders. Env var keys must match `^[A-Za-z_][A-Za-z0-9_]*$` before interpolation — see `.claude/rules/input-validation.md`.

Out of scope for DeepSec runs: pure frontend styling / accessibility / responsive-layout concerns (Playwright + Biome cover those); Markdown / docs-only diffs; migration DDL that only renames or reorders columns.

## Known false-positive patterns (do not raise as findings)

These recur in scans and are not bugs:

- **"Missing `isWorkspaceMember` check on a header-scoped route."** If the route validates `X-Workspace-Id` via `workspaceIdHeader` and reads the workspace from the header, `authMiddleware` has already enforced membership — a second `isWorkspaceMember` call is redundant. Only flag missing membership checks on **by-ID routes** where the workspace is derived from the resource row, not the header. This is the single most common false positive on this repo.
- **"Bearer token accepted without further validation."** `ank_`-prefixed API keys are the intended auth format; `validateApiKey` handles cryptographic verification. A route that only reads `c.get('actorId')` from context is trusting the middleware, which is correct.
- **"Actor id / workspace id used unchecked in `WHERE` clauses."** Both come from `authMiddleware` after validation, not from the request body. Only flag if the value used in the query comes from the request payload or a URL segment without a subsequent membership check.
- **"Missing input validation on route body."** All handlers accept `c.req.valid('json' | 'header' | 'query')` — Zod validation via `OpenAPIHono` is applied before the handler runs. The schemas live in `packages/shared/src/schemas/`.
- **"Console-logged token / secret."** `logger` is a structured logger (`apps/dev/src/lib/logger.ts`) that filters `Authorization` and secret-shaped keys. Raw `console.log` of a token in a handler is a real finding; `logger.info(...)` of a request context that happens to contain a header is not.

## Real, unresolved patterns worth surfacing when you see them

- Batch reads of `objects` / `relationships` by a set of ids without a `workspace_id = $1` predicate. The `GET /api/objects/:id/graph` handler in `apps/dev/src/routes/objects.ts` is a known instance and is being fixed in a separate task — do flag the same shape in other handlers.
- `POST /api/relationships` accepting `source_id` / `target_id` without asserting both endpoints belong to the caller's workspace.
- Session-manager forwarding an attacker-supplied `body.actor_id` or `body.base_image` verbatim to container launch.

## References that ground your review

- `CLAUDE.md` (repo root) — the "reviewer pitfall" bullet in `## Architecture` names the header-scoped-route false positive verbatim; treat it as authoritative.
- `.claude/rules/known-pitfalls.md` — the living registry of recurring bugs. Every entry has a "when to check" and a "fix pattern"; use them as concrete lenses.
- `.claude/rules/input-validation.md` — the boundary-validation rulebook (numeric parsing, env-var keys, PG NOTIFY payloads, webhook payloads).
- `SECURITY.md` — the declared scope and reporting channel.
- `.maskin/protected-paths.yml` — the two-human-required floor list. Any diff touching these paths is high-risk regardless of size; take findings there seriously even when small.
