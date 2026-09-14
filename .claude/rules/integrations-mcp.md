# Integrations & MCP — Class Rules

Mirror of the Integrations & MCP section from the workspace's [Tech
principles & best-practices](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/c001d7d5-da76-4153-ae5a-2b83e329b791)
doc, checked into the repo so every Claude Code session sees the same rules.
Owner: CTO. Any change to a principle here must be mirrored back to that doc.

## Core principles

1. **Integration surface must have one source of truth.** — Any new MCP
   integration must be declarable in a single file
   (`apps/dev/src/lib/integrations/providers/{name}/config.ts`) that every
   downstream consumer derives from. When we can't derive it, we CI-assert
   equivalence.
2. **Every connect flow needs a symmetric disconnect flow.** — If we call an
   external side to create state (Unipile account, GitHub installation,
   webhook subscription), the disconnect handler calls the matching delete.
3. **Access is gated on live credential status, never on cached
   registration.** — A fan-out MCP instance being present in the in-process
   registry is not proof the underlying integration is connected. Handlers
   consult `integrations.status` at the boundary.
4. **`autoInject: true` on a provider config is not evidence the server
   reaches a session.** — Registering `mcp.autoInject` only records intent;
   the session-manager path that actually attaches the server can fail for
   reasons unrelated to the config (e.g. token-manager throwing on a
   credential blob that has no `accessToken`, as happened for linkedin-unipile
   on 2026-09-11). The path must be tested with the provider's real
   credential shape — see `apps/dev/src/__tests__/lib/integrations/providers.contract.test.ts`.

## Chosen patterns

- **Provider manifest as SoT for MCP integrations.** The `config.ts` for a
  provider declares `name`, `displayName`, `auth`, `webhook`, `mcp` (server
  spec), and — where a manifest expansion is in flight — `identityFanout`
  (`none` | `per-installation` | `per-identity`), `presetLabel` (drives UI
  quick-add), `actorScoping` (drives `lookup.ts` allow-list), and
  `disconnect: { revokeUpstream, deregisterMcp }`. UI code and `lookup.ts`
  derive from the config — no parallel maps.
- **CI contract test for provider readiness.**
  `apps/dev/src/__tests__/lib/integrations/providers.contract.test.ts`
  iterates every registered provider and asserts:
  1. For every provider with `mcp.autoInject && mcp.server`, driving
     `SessionManager.startSession` for a workspace with an active integration
     for that provider attaches the provider's `mcp.server` verbatim under
     `MCP_SERVERS_JSON.mcpServers['integration-<provider>']`, with no
     `Failed to load credentials for <provider>` warning logged. Simulates
     the real credential blob per provider (OAuth token for slack/posthog,
     `{ account_id }` for linkedin-unipile).
  2. For every provider with `mcp` declared, `GET /api/integrations/providers`
     surfaces `mcp.autoInject`, and surfaces `mcp.server` whenever `autoInject`
     is true (github is exempt from the `server` half — it fans out per
     installation with literal tokens).
- **Per-installation fan-out for multi-account providers.** GitHub's
  `handleAddGithub` in `apps/web/src/components/agents/mcp-servers.tsx` is
  the reference shape: enumerate integrations, write one
  `{provider}-{external_slug}` `mcpServers` row per install with a
  per-installation discriminator. Never dedupe distinct installations under
  one provider row.
- **Cross-provider structural refactors are Developer-driven, Architect-
  reviewed.** When a task rewrites shared infrastructure that spans providers
  (a manifest, a lookup layer, a contract test), the driver stays Developer
  and Architect is engaged via a mandatory design-review sign-off on the
  shape before code lands — not as a separate Architect-driven task, unless
  the design work is large enough to be its own artifact.

## Explicitly rejected

- **Hand-maintained parallel registry files.** The pattern where
  `INTEGRATION_MCP_PRESETS` in `mcp-servers.tsx` and the provider `config.ts`
  are separately updated is rejected. The template file's comment saying
  "also add a matching entry" is documentation, not enforcement, and it
  silently failed on linkedin-unipile. Delete the parallel file, derive from
  `config.ts`.
- **Trusting the in-process MCP registry as proof of credential state.** Do
  not use the presence of a registered fan-out instance as an authorization
  signal. Registry is a performance cache; `integrations.status` is the truth.
- **Architect as driver of coding tasks.** Even when the coding task is
  architectural (manifests, cross-provider contracts, structural refactors).
  Route to Developer with an Architect design-review gate instead. Driving
  Architect against its own advise/propose/document scope causes
  hallucination or stalls; we've seen it before.
