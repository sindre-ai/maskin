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
4. **Every provider is user-added per-agent, not workspace-auto-injected.** —
   `mcp.autoInject: true` is not the shipped contract for any provider going
   forward (Magnus 2026-09-14, reversed the workspace-wide auto-inject that
   shipped for linkedin-unipile in PR #1595). A workspace has many agents; a
   workspace-wide auto-attach means every agent in that workspace silently
   picks up every connected credential's tools whether the operator wanted
   it or not. The UX is per-agent Quick Add: one button per credential
   (GitHub — per-installation) or per identity (LinkedIn — per-identity),
   using the preset-button pattern in
   `apps/web/src/components/agents/mcp-servers.tsx`.
5. **An MCP server that authenticates on the Maskin API key can attach
   without a per-provider token.** — The linkedin-unipile shape: credential
   blob is `{ account_id }` with no `accessToken`. `TokenManager.getValidToken`
   throws by design. Session-manager's `serverSpecReferencesEnvKey` short-
   circuit (`apps/dev/src/services/session-manager.ts`) treats that throw as
   expected for any provider whose MCP server template does NOT reference its
   own `mcp.envKey`, and continues past it. The contract lives in
   `apps/dev/src/__tests__/lib/integrations/providers.contract.test.ts`; the
   test drives session-manager with a credential blob missing accessToken and
   asserts the session boots without a `Failed to load credentials` warning.

## Chosen patterns

- **Provider manifest as SoT for MCP integrations.** The `config.ts` for a
  provider declares `name`, `displayName`, `auth`, `webhook`, `mcp` (server
  spec), and — where a manifest expansion is in flight — `identityFanout`
  (`none` | `per-installation` | `per-identity`), `presetLabel` (drives UI
  quick-add), `actorScoping` (drives `lookup.ts` allow-list), and
  `disconnect: { revokeUpstream, deregisterMcp }`. UI code and `lookup.ts`
  derive from the config — no parallel maps.
- **Per-identity Quick Add for multi-identity providers.** LinkedIn is the
  reference. Every connected identity — the human profile plus each admined
  company page — is one MCP instance keyed by
  `linkedin-{unipileAccSlug}-{identitySlug}`, served at
  `/api/integrations/linkedin-unipile/mcp/:instanceSlug`, and offered as one
  Quick Add button in the agent MCP panel labelled with the identity's
  display name. Clicking a button writes one `mcpServers` entry pointing at
  that identity's endpoint only — no shared endpoint, no hidden filter
  param, no cross-identity leakage.
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

- **Workspace-wide auto-inject for any provider.** Reversed 2026-09-14 —
  see core principle 4. The `mcp.autoInject` flag stays on the type for now
  (session-manager still reads it; a future task deletes the flag entirely
  once no provider config sets it to true), but every new provider ships
  with `autoInject: false` and the Quick Add UX is the only way for tools
  to reach an agent.
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
