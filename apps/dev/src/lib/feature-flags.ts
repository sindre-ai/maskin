// Backend-driven feature flags. Config lives in the apps/dev environment and is
// read at runtime, so turning a feature on for testers (or taking it back
// away) is an env change + restart — never a frontend rebuild. All three vars
// are optional and default to empty, which means every flag is off for
// everyone.
//
//   FF_TESTER_ACTOR_IDS=<uuid>,<uuid>          actors who see tester features
//   FF_TESTER_FEATURES=some-flag,other-flag    flag ids on for those tester actors
//   FF_WORKSPACE_FEATURES=<uuid>:<flag>,...    workspace-scoped flag entries
//
// A flag has exactly two states: off, or on for the tester actors / listed
// workspaces. There is deliberately no "on for everyone" setting — shipping a
// feature to everyone means deleting its flag (drop the boundary, delete any
// legacy branch, remove the id from FLAGS below and from the env lists), not
// parking it in a list that only ever grows.
//
// Workspace-scoped entries exist alongside the per-actor pair for backend
// surfaces whose off-state is workspace-wide (trigger-engine v2's persistent
// cooldown store and hold-and-replay queue read this shape). `isFlagEnabled`
// stays actor-scoped; `isFlagEnabledForWorkspace` OR-combines workspace-scoped
// enables with an optional actor-scoped fallback.
//
// These are deliberately NOT VITE_-prefixed: tester actor ids and
// workspace-scoped entries stay server-side and never reach the browser.

// Every known flag id. Ids absent from this registry always resolve to false,
// so a typo in FF_TESTER_FEATURES can't invent a flag. Add an entry here as the
// first step of introducing a new flag.
//
// `loops-v4-polish` gates the Loops & Loop detail v4 UX/UI polish bet
// (bet/d166-loops-v4-polish). The three sub-flags let a single delta be
// reverted without dropping the rest: `.targets` for D5 (Loop targets),
// `.step_flow` for D6 (vertical step flow + escalation reconciler), and
// `.unread` for D8 (unread boundary + Mark read). Every sub-flag is
// additionally gated by the umbrella at each read site — so flipping the
// umbrella off kills every downstream v4 delta at once. See
// `.claude/rules/feature-flags.md` for the boundary rule and
// `bet/d166-loops-v4-polish` for the ship / rollback plan.
export const FLAGS = {
	/**
	 * LinkedIn Identity add-on visibility on the plan surface
	 * (Settings > Billing). When off, the $49/connected-identity/month line is
	 * hidden regardless of how many `linkedin-unipile` credentials the
	 * workspace has connected. Actor-scoped rollout — add the pilot workspace
	 * admin's actor id to `FF_TESTER_ACTOR_IDS` and this flag id to
	 * `FF_TESTER_FEATURES` to reveal. The line still stays hidden when the
	 * flag is on but no credentials are connected (see
	 * `apps/dev/src/lib/linkedin-addon.ts`).
	 */
	LINKEDIN_ADDON_VISIBLE: 'linkedin-addon-visible',
	/**
	 * Sales Rep loop's `Draft next LinkedIn touch` step: off means "draft
	 * posted for human review only" (today's behaviour); on means "draft posted
	 * → sent via `linkedin_send_message` with an idempotency key derived from
	 * `(contact_id, draft_id)`". Per-actor, so the workspace admin can opt in
	 * their own Sales Rep driver-actor without flipping every workspace at
	 * once. See the parent bet [First-party LinkedIn MCP — LinkedIn-backed,
	 * customer-auth](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/56c2ffd7-7e45-448b-a409-c08c15755f9a)
	 * — this flag is the "human-fire path stays available (feature flag on the
	 * loop) so early customers can opt in gradually" gate from the spec's
	 * §Behavioral shape. Behavioural (not visual-layer) — the invocation
	 * surface Task 3 delivers (`linkedin_send_message`) reads this via
	 * `resolveFlags(driverActorId, config)` on each Sales Rep loop tick.
	 * Retire once autosend is the default for every workspace with a
	 * connected `linkedin-unipile` credential.
	 */
	SALES_REP_LINKEDIN_AUTOSEND: 'sales_rep__linkedin_autosend',
	/**
	 * Slack setup UX v2 — channel-picker membership indicators, per-row hints,
	 * >2000-channel truncation footer, error state, and the picker-usage
	 * PostHog event. Enabled per tester actor; roll to Marketplace-live
	 * workspaces once the dogfood workspace (mesh-firm) has proven it out.
	 * See parent bet 'Slack setup UX' for the shape spec.
	 */
	SLACK_SETUP_UX_V2: 'slack-setup-ux-v2',
	/**
	 * Google Meet integration visibility on the Settings > Integrations page.
	 * When off, the provider card + Connect button are filtered out of the
	 * providers list rendered by `apps/web/src/routes/_authed/$workspaceId/settings/integrations.tsx`
	 * — the customer sees no google-meet entry point at all. When on, google-meet
	 * appears alongside every other OAuth provider (Gmail, GCal, Slack, ...) with
	 * a standard Connect button. Per-actor behaviour gate, never shared state:
	 * the backend still registers the provider unconditionally, so
	 * `POST /api/integrations/google-meet/connect`
	 * and the seven `google_meet__*` MCP tools stay reachable for tester actors
	 * (add them to `FF_TESTER_ACTOR_IDS` + `google-meet-integration-ui` to
	 * `FF_TESTER_FEATURES`). See parent bet [Google Meet MCP — cover the top
	 * JTBDs across the workspace](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/947eee4d-9b30-49c7-968c-9376b4f5d80e)
	 * for the rollout plan. Retire (drop the boundary + delete this entry) once
	 * google-meet ships to every workspace.
	 */
	GOOGLE_MEET_INTEGRATION_UI: 'google-meet-integration-ui',
	/**
	 * Resend integration visibility on the Settings > Integrations page. When
	 * off, the provider card + multi-step connect dialog are filtered out of the
	 * providers list rendered by `apps/web/src/routes/_authed/$workspaceId/settings/integrations.tsx`
	 * and the awaiting_secret resume affordance for resend never shows. When on,
	 * the resend card appears with the Slice 2 connect dialog (Task 4). Per-actor
	 * behaviour gate, never shared state: the backend registers the provider
	 * unconditionally so `POST /api/integrations/resend/connect`, the dedicated
	 * `/api/webhooks/resend/:token` route, and MCP env-var injection stay
	 * reachable for tester actors (add them to `FF_TESTER_ACTOR_IDS` +
	 * `resend-integration-ui` to `FF_TESTER_FEATURES`). See parent bet [Resend
	 * integration per workspace](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/cf2bcc85-8a71-460b-975b-1635dd87594e)
	 * for the rollout plan. Retire (drop the boundary + delete this entry) once
	 * resend ships to every workspace.
	 */
	RESEND_INTEGRATION_UI: 'resend-integration-ui',
	/**
	 * Chat composer `+` menu collapse — replaces the three-item **Reference an
	 * object** / **Mention an agent** / **Create an object** dropdown with a
	 * single **Attach a file** row, and promotes the `/` and `@` primitives via
	 * the composer placeholder. Owned by task **6321aecf**, part of parent bet
	 * **bet/f21a-chat-composer-completeness** ("Chat composer completeness").
	 * OFF preserves today's three-item menu and today's placeholder verbatim.
	 * See `.claude/rules/feature-flags.md` for the boundary rule.
	 */
	CHAT_PLUS_MENU_ATTACH_ONLY: 'chat-plus-menu-attach-only',
	loopsV4Polish: 'loops-v4-polish',
	loopsV4PolishTargets: 'loops-v4-polish.targets',
	loopsV4PolishStepFlow: 'loops-v4-polish.step_flow',
	loopsV4PolishUnread: 'loops-v4-polish.unread',
	/**
	 * `chats-v4-polish` gates the Chats v4 UX/UI polish bet
	 * (bet/bdda1c1e-chats-v4-polish). The five sub-flags let a single delta be
	 * reverted without dropping the rest: `.list` for the conversation-list
	 * end-of-history footer, `.header` for the thread-header controls (loop
	 * chip, copy whole conversation, mark as unread, mobile overflow menu),
	 * `.banner` for the resume-banner restyle, `.bubbles` for the message-bubble
	 * hover actions + attachment eyebrow, and `.new_chat` for the new-chat chip
	 * picker. Every sub-flag is additionally gated by the umbrella at each read
	 * site — so flipping the umbrella off kills every downstream v4 delta at
	 * once. See `.claude/rules/feature-flags.md` for the boundary rule and
	 * `bet/bdda1c1e-chats-v4-polish` for the ship / rollback plan.
	 */
	chatsV4Polish: 'chats-v4-polish',
	chatsV4PolishList: 'chats-v4-polish.list',
	chatsV4PolishHeader: 'chats-v4-polish.header',
	chatsV4PolishBanner: 'chats-v4-polish.banner',
	chatsV4PolishBubbles: 'chats-v4-polish.bubbles',
	chatsV4PolishNewChat: 'chats-v4-polish.new_chat',
	/**
	 * Chat thread `HANDED OFF` sub-agent delegation strip
	 * (bet/444b-handed-off-strip). When on, an agent message with ≥1
	 * **spawned_sessions** row renders the delegation strip beneath its
	 * content: one row per sub-agent with a live-updating QUEUED / WORKING /
	 * DONE / FAILED pill, deps clause, elapsed timer, current activity and
	 * row-click through to the sub-agent's own thread. Visual-layer only —
	 * the embed and SSE contract ship to everyone regardless of this flag,
	 * so a flag flip toggles the strip on or off without affecting how sub-
	 * sessions run or how their state propagates.
	 */
	HANDED_OFF_STRIP: 'handed-off-strip',
	/**
	 * Chat composer `/` picker v2 — unified search-and-create surface.
	 * When off, typing `/` opens the create-only "Turn this into an object"
	 * dropdown (today's behaviour). When on, `/` opens the unified picker with
	 * Reference (existing objects via `search_objects`) on top and Create new
	 * (Task / Bet / Insight) below, and NEWKIND prefixes like `/task ` become
	 * type-filter chips in the composer. See parent bet
	 * [Chat composer completeness](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/f21ad246-ebef-4cd2-93e0-aa46c83ed954).
	 * Retire once the unified picker is the default for every workspace and the
	 * legacy `turnIntoOpen` branch in `apps/web/src/components/chat/chat.tsx`
	 * has been deleted.
	 */
	CHAT_SLASH_PICKER_V2: 'chat-slash-picker-v2',
	/**
	 * Gates the S2 writer hook on the parent bet
	 * [Extend the graph: files, chats, and sessions as first-class nodes]
	 * (https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/34706e2f-943f-49f5-a832-400a702952c2).
	 * Off means the `recordEvent` helper never writes `session → object|file`
	 * `produced_by` edges and `POST /api/sessions` never writes a
	 * `conversation → session` `spawned` edge — the mutations still succeed
	 * silently, no lineage rows land. On (per driver-actor) means both writes
	 * fire whenever their preconditions hold (`X-Maskin-Session-Id` header
	 * present on the mutation, or `conversationId` set at session CREATE).
	 * Migration 0074 (which widens the CHECK constraint and adds the
	 * `metadata` column) ships LIVE regardless of this flag: schema tolerance
	 * with zero writes is safe. Retire once the hook is on for every workspace
	 * and the Task 4 `<Origin>` block + Task 5 Chat Produced pane depend on
	 * the edges being present.
	 */
	GRAPH_PROVENANCE_WRITES: 'graph-provenance-writes',
	/**
	 * Gates the trigger-engine v2 rollout (bet
	 * [Fix the trigger engine](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/f46b18f7-1cce-487b-9113-8657a6e30b16)).
	 * Off preserves today's behaviour on every axis — matcher, cooldown,
	 * event queue, and comment action. On (per tester actor for frontend
	 * reads, per workspace via `FF_WORKSPACE_FEATURES` for the backend read
	 * sites S1 shipped) unlocks:
	 *
	 *  - matcher v2 list-value semantics (bet #8)
	 *  - persistent cooldown store (bet #7)
	 *  - hold-and-replay event queue (bet #6)
	 *  - the `action = commented` trigger surface (bet #12) — the trigger
	 *    builder in `apps/web/src/components/triggers/trigger-form.tsx`
	 *    reads this flag via `useFeatureFlag('trigger_engine_v2')` and hides
	 *    the "On comment posted" action + its filter block when off, and the
	 *    matcher in `apps/dev/src/services/trigger-runner.ts` rejects
	 *    `action = commented` when off so a trigger saved under an old flag
	 *    state never silently misses events.
	 *
	 * Task S7 formalises the workspace-scoped resolver
	 * (`isFlagEnabledForWorkspace`) that the matcher's cooldown/suppression
	 * gate points at; the entry lives here from S6 so the frontend gate
	 * resolves against the registry today. Retire once the four v2 surfaces
	 * are on for every workspace.
	 */
	TRIGGER_ENGINE_V2: 'trigger_engine_v2',
} as const

export type FlagId = (typeof FLAGS)[keyof typeof FLAGS]

export interface FeatureFlagConfig {
	/** Lowercased for case-insensitive UUID comparison. */
	testerActorIds: Set<string>
	testerFlags: Set<string>
	/**
	 * Workspace-scoped enables sourced from `FF_WORKSPACE_FEATURES`. Each entry
	 * is the literal `${workspaceId}:${flagId}` pair, both sides lowercased for
	 * case-insensitive comparison. A workspace absent from this set has every
	 * flag off from the workspace-scoped resolver — the actor-scoped path stays
	 * independent, so an actor listed in `FF_TESTER_ACTOR_IDS` still gets tester
	 * behaviour on the frontend regardless of whether their workspace is in
	 * this set.
	 */
	workspaceFeatures: Set<string>
}

function parseList(raw: string | undefined): string[] {
	if (!raw) return []
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

// Format: `<workspaceId>:<flagId>` per entry. Entries missing the delimiter or
// with an empty half are dropped rather than throwing — a malformed value must
// not white-screen the app on boot.
function parseWorkspaceFeatures(raw: string | undefined): Set<string> {
	const out = new Set<string>()
	for (const entry of parseList(raw)) {
		const colon = entry.indexOf(':')
		if (colon <= 0 || colon === entry.length - 1) continue
		const workspaceId = entry.slice(0, colon).trim().toLowerCase()
		const flagId = entry.slice(colon + 1).trim()
		if (!workspaceId || !flagId) continue
		out.add(`${workspaceId}:${flagId}`)
	}
	return out
}

// `env` is injected so tests never have to mutate process.env — same shape as
// readFallbackConfig() in ./llm-routing.ts.
export function parseFeatureFlagConfig(env: NodeJS.ProcessEnv = process.env): FeatureFlagConfig {
	return {
		testerActorIds: new Set(parseList(env.FF_TESTER_ACTOR_IDS).map((id) => id.toLowerCase())),
		testerFlags: new Set(parseList(env.FF_TESTER_FEATURES)),
		workspaceFeatures: parseWorkspaceFeatures(env.FF_WORKSPACE_FEATURES),
	}
}

// Resolves every registered flag for one actor: true only when the flag is
// listed in FF_TESTER_FEATURES and this actor is listed in FF_TESTER_ACTOR_IDS.
export function resolveFlags(
	actorId: string,
	config: FeatureFlagConfig,
	// Injected so the registry can be exercised in tests while FLAGS is empty.
	registry: Record<string, string> = FLAGS,
): Record<string, boolean> {
	const isTester = config.testerActorIds.has(actorId.trim().toLowerCase())
	const resolved: Record<string, boolean> = {}
	for (const flagId of Object.values(registry)) {
		resolved[flagId] = config.testerFlags.has(flagId) && isTester
	}
	return resolved
}

// Whether a specific flag is on for a specific actor. Same rule as resolveFlags
// but for a single lookup — used at server-side call sites (e.g. the trigger
// route deciding whether to fire the Slack setup service post-commit).
export function isFlagEnabled(
	actorId: string,
	flagId: string,
	config: FeatureFlagConfig = getFeatureFlagConfig(),
	registry: Record<string, string> = FLAGS,
): boolean {
	if (!Object.values(registry).includes(flagId)) return false
	if (!config.testerFlags.has(flagId)) return false
	return config.testerActorIds.has(actorId.trim().toLowerCase())
}

/**
 * Whether a specific flag is on for a specific workspace, with optional
 * OR-fallback to actor-scoped resolution. Backend surfaces whose off-state is
 * workspace-wide (persistent cooldown store, hold-and-replay queue) read this
 * — one workspace can flip while its neighbours stay off, without every
 * tester in the workspace needing to be listed individually.
 *
 * OR-semantics: a workspace-scoped enable in `FF_WORKSPACE_FEATURES` returns
 * true; if `config.actorId` is supplied AND that actor is a tester for
 * `flagId`, returns true. Otherwise false. Unknown flag ids (typos, ids not
 * in the registry) always resolve to false.
 *
 * `config.flagConfig` is a test seam — normal callers omit it and let the
 * memoized `getFeatureFlagConfig()` supply the env-parsed config, matching
 * `isFlagEnabled`'s default behaviour.
 */
export function isFlagEnabledForWorkspace(
	workspaceId: string,
	flagId: string,
	config?: { actorId?: string; flagConfig?: FeatureFlagConfig },
	registry: Record<string, string> = FLAGS,
): boolean {
	if (!Object.values(registry).includes(flagId)) return false
	const flagConfig = config?.flagConfig ?? getFeatureFlagConfig()
	const target = `${workspaceId.trim().toLowerCase()}:${flagId}`
	if (flagConfig.workspaceFeatures.has(target)) return true
	if (config?.actorId && isFlagEnabled(config.actorId, flagId, flagConfig, registry)) return true
	return false
}

let _config: FeatureFlagConfig | null = null

// Parsed once and memoized — env cannot change without a process restart.
// Lazy rather than top-of-module so test import order can't freeze a stale read.
export function getFeatureFlagConfig(): FeatureFlagConfig {
	if (_config === null) _config = parseFeatureFlagConfig()
	return _config
}

// Test-only: re-parse after env changes.
export function _resetFeatureFlagConfig(): void {
	_config = null
}
