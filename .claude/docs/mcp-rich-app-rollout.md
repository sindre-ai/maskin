# MCP Rich App — Vertical-Slice Rollout

Splitting PR #375 (~11.7k LOC, branch `mcp/rich-app-with-actors-fix`) into reviewable PRs. PR #375 itself stays open and untouched as the integration target / source of truth — each slice is carved from it onto a fresh branch off `main` and opened as its own PR.

## Convention

- **Source branch (do not modify):** `mcp/rich-app-with-actors-fix` (#375)
- **Each slice:** new branch off `origin/main`, named `mcp/<slice>` (e.g. `mcp/scaffolding`, `mcp/schema`).
- **How to carve:** `git checkout mcp/rich-app-with-actors-fix -- <paths>`, then trim what doesn't belong in this slice.
- **Gate per slice:** `pnpm lint` (ignore gitignored `.claude/settings.local.json`), `pnpm type-check`, `pnpm test -- -- --run`, `pnpm build` — all green before opening PR.
- **Tests travel with the code they cover** — never split tests into a separate PR.
- **Docs deleted:** `docs/dogfood-demo.md`, `docs/integrations.md`, `packages/mcp/ACTIONS.md`, `packages/mcp/RENDERING.md` — do not include in any slice.

## Order

PR 0 must land first. After that, the vertical slices can land in any order, but lower-numbered ones are more self-contained and lower risk.

| #   | Slice                        | Branch                | PR     | Status  | Notes |
| --- | ---------------------------- | --------------------- | ------ | ------- | ----- |
| 0   | Scaffolding                  | `mcp/scaffolding`     | #376   | ✅ open  | Foundation. Required by every later slice. |
| 1   | Schema                       | `mcp/schema`          | #378   | ✅ open  | 5 new tools, schema card, `schema-form` / `schema-select` / `use-workspace-schema`. Cleanest vertical. Stacked on `mcp/scaffolding`. |
| 2   | Integrations + OAuth-from-chat | `mcp/integrations`  | —      | pending | Integrations card + `/oauth-return` route + `apps/dev/src/routes/integrations.ts` shim + `vite.config` ngrok-allowed-hosts + `apps/dev/src/index.ts` FRONTEND_URL warning. |
| 3   | Sessions                     | `mcp/sessions`        | —      | pending | Sessions card + flip 7 sessions tools' `_meta.ui.resourceUri`. |
| 4   | Skills                       | `mcp/skills`          | —      | pending | Skills card + flip 5 skills tools. |
| 5   | Notifications                | `mcp/notifications`   | —      | pending | Notifications card + flip 5 notification tools. |
| 6   | LLM keys                     | `mcp/llm-keys`        | —      | pending | LLM keys card + flip 3 llm-keys tools. |
| 7   | Members                      | `mcp/members`         | —      | pending | Members card + flip `add_workspace_member`. |
| 8   | Extensions                   | `mcp/extensions`      | —      | pending | Extensions card + flip 4 extensions tools. |
| 9   | Objects + Graph + Relationships | `mcp/objects-graph` | #387   | open    | Bundle: shared `extractors.ts`, `metadata-editor.tsx`, `relationships-editor.tsx`, `widgets/*` catalog (object-card, object-kanban, object-list-table, relationship-graph, activity-feed, content-fold), `owner-action`, `status-action`. Adds `update_objects.owner` field. **Stacks on `mcp/schema`** (uses `schema-form` + `use-workspace-schema`), not directly on `mcp/scaffolding`. |
| 10  | Actors + Events + Triggers   | `mcp/actors-triggers` | TBD    | open    | Smaller cards. **Stacks on `mcp/objects-graph`** because the actors card uses `ContentFold` (introduced by slice 9). |

## What goes in each slice

For every slice from #1 onward, the diff is roughly:

1. **Tool side (`packages/mcp/src/server.ts`):**
   - For new tools (only #1): full registration block + entries in `tools.ts`.
   - For existing tools: flip `_meta.ui.resourceUri` from `_meta: {}` (or `UI_RESOURCES.workspaces`) to the slice's new `UI_RESOURCES.<name>`.
   - Add the new entry to the `UI_RESOURCES` object.
2. **Card UI:**
   - `apps/web/src/mcp-apps/<slice>/app.tsx` + `index.html`
   - any slice-specific helpers (extractors, editors, etc.)
3. **Build registration:**
   - Add `<slice>` to the `apps` array in `apps/web/scripts/build-mcp.mjs`.
4. **Tests:**
   - `apps/web/src/__tests__/mcp-apps/<slice>/*` — card-level tests
   - `packages/mcp/src/__tests__/server.test.ts` — additions for any new tool

## Scaffolding PR (#376) — what's in it

Already landed in `mcp/scaffolding`. Subsequent slices can rely on:

- `meta()` envelope helper on every tool response (`toolName`, `webAppBaseUrl`, `workspaceId`)
- Telemetry wrapper around `registerAppTool` + `tool_call` / `mutation` events
- `POST /api/telemetry/mcp` route + `mcpTelemetry` table (migration `0015_mcp_telemetry`)
- `web-app-urls.ts` URL contract in `@maskin/shared`
- `WEB_APP_URL` in `turbo.json` `globalPassThroughEnv`
- MCP resource picker (`maskin-object`, `maskin-actor`, `maskin-trigger`)
- Cross-cutting primitives in `apps/web/src/mcp-apps/shared/`:
  `action-button`, `confirm-dialog`, `use-object-mutation`, `policy`, `web-app-link`, `tool-history`, `error-state`, `loading-state`, `compact-empty`, `mcp-app-provider` (with history + `useWebAppContext`)

## Migration numbering

PR #375 names its telemetry migration `0014_mcp_telemetry.sql`, but `0014_backfill_maskin_mcp_on_agents.sql` already exists on `main`. Scaffolding renames it to **`0015_mcp_telemetry.sql`**. Future slices that add migrations should pick the next free number off `main` at carve time.

## Resuming this work in a new context

1. `git fetch origin && git checkout mcp/<next-slice> 2>/dev/null || git checkout -b mcp/<next-slice> origin/main`
2. Pick the next pending slice from the table above.
3. Carve files from `mcp/rich-app-with-actors-fix` per the slice's scope.
4. Verify lint/type-check/tests/build, commit, push, open PR, update this file's table with the PR number + status.
