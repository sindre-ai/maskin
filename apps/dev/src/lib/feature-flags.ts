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
// surfaces whose off-state is workspace-wide. `isFlagEnabled`
// stays actor-scoped; `isFlagEnabledForWorkspace` OR-combines workspace-scoped
// enables with an optional actor-scoped fallback.
//
// These are deliberately NOT VITE_-prefixed: tester actor ids and
// workspace-scoped entries stay server-side and never reach the browser.

// Every known flag id. Ids absent from this registry always resolve to false,
// so a typo in FF_TESTER_FEATURES can't invent a flag. Add an entry here as the
// first step of introducing a new flag.
export const FLAGS = {
	/**
	 * Google Drive integration visibility on the Settings > Integrations page.
	 * When off, the provider card + Connect button are filtered out of the
	 * providers list rendered by `apps/web/src/routes/_authed/$workspaceId/settings/integrations.tsx`
	 * — the customer sees no google-drive entry point at all. When on, google-drive
	 * appears alongside every other OAuth provider with a standard Connect button.
	 * Per-actor behaviour gate, never shared state: the backend still registers the
	 * provider unconditionally, so `POST /api/integrations/google-drive/connect` and
	 * the `google_drive__*` MCP tools stay reachable for tester actors (add them to
	 * `FF_TESTER_ACTOR_IDS` + `google-drive-integration-ui` to `FF_TESTER_FEATURES`).
	 * See parent bet [Google Drive MCP — cover the Drive-shaped JTBDs across the workspace](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/e5cd108b-ad30-498b-a4ac-e961587389c5)
	 * for the rollout plan. Retire (drop the boundary + delete this entry) once
	 * google-drive ships to every workspace.
	 */
	GOOGLE_DRIVE_INTEGRATION_UI: 'google-drive-integration-ui',
	/**
	 * Gates the weekly capability note that Chief of Staff sends in a person's
	 * 1-1 (bet
	 * [Agents look through connected integrations for new things they can do](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/3dae5ff5-7c94-41ee-8687-0023b37994f2)).
	 * Backend only, workspace-scoped: read with isFlagEnabledForWorkspace at the
	 * top of runCapabilityDigest. Off means no note is sent in that workspace and
	 * findings stay pending, so they merge into the first note once it is on.
	 * The scan itself is not flagged (it only writes events); its off-switch is
	 * the env var FEATURE_CAPABILITY_SCAN=0. Retire once the notes are on for
	 * everyone.
	 */
	AGENT_PROACTIVE_1_1: 'agent-proactive-1-1',
	/**
	 * Gates iOS dictation through the backend transcription route (task
	 * [iOS dictation: send speech to the backend transcription route](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/0a322ceb-338c-4b2d-b796-fcb228d0a7a4)).
	 * Read by the iPhone app once per launch from GET /api/feature-flags, for the
	 * signed-in actor. Off means the app dictates with Apple's on-device recogniser
	 * as before and no audio leaves the phone. On means each phrase is sent to
	 * POST /transcriptions, and Apple's recogniser takes over if a request fails.
	 * The route itself is not flagged. Retire once iOS dictation is on for everyone.
	 */
	IOS_BACKEND_DICTATION: 'ios-backend-dictation',
	/**
	 * Web chat: images and files on a message sit outside the text bubble (images as their own
	 * rounded blocks, files as cards), and only the text keeps a bubble. Read once, in
	 * `apps/web/src/components/chat/message-bubble.tsx`. Off keeps the files inside the bubble as
	 * before. Visual only, per actor; no data or API change. Retire (drop the old branch and this
	 * entry) once it is on for everyone.
	 */
	CHAT_ATTACHMENTS_LIFTED: 'chat-attachments-lifted',
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
