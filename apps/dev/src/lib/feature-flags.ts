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
	 * Gates the Daily budget setting in Settings, Billing (bet [A daily token budget,
	 * spent on the right work first](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/0f3ae096-7efc-4412-aba0-7a21a91ba040),
	 * slice 1a). UI only: the route layout reads it once and mounts the section
	 * under the usage banner. Off means Billing looks as it does today. The
	 * storage and API behind it are additive and safe with the flag off. Retire
	 * once the daily budget is on for everyone.
	 */
	DAILY_BUDGET: 'daily-budget',
	/**
	 * Gates the Paste and Copy buttons on the Computer view, which move plain text
	 * between the person's clipboard and the agent's computer while they are in
	 * control. Frontend only: read with useFeatureFlag in desktop-viewer. Retire
	 * once the buttons are on for everyone.
	 */
	COMPUTER_CLIPBOARD: 'computer-clipboard',
	/**
	 * Claude connector sign-in. Gates only what a person sees and does: the consent preview
	 * and approve routes under /api/oauth/authorize answer 403 access_denied for non-testers,
	 * and the Claude tab and consent page read the same id. Default off (FF_TESTER_FEATURES
	 * empty). Listing and disconnecting connections is NOT behind this flag: a flag that hides
	 * the only revoke button is a trap. Discovery, the token endpoint and token acceptance act
	 * before any person is known and sit behind the MASKIN_MCP_OAUTH_ENABLED switch instead.
	 * See docs/reference/mcp-oauth.md. Retire when the connector ships to everyone.
	 */
	MCP_OAUTH_CONSENT: 'mcp-oauth-consent',
	/**
	 * Gates editing a draft's text in place on the web For You card, with Send saving the
	 * edit and approving the saved text in one step. Frontend only: read with useFeatureFlag
	 * in draft-preview. Retire once editing is on for everyone.
	 */
	FORYOU_DRAFT_EDIT: 'foryou-draft-edit',
	/**
	 * Gates the visual layer of agent change review (bet
	 * [Humans accept, edit or reject an agent's proposed changes to a file instead of re-reading the whole thing](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/a0daec7c-7c63-4898-bfac-a4dfc98a2d23)):
	 * the proposal banner above a markdown file and the review view that
	 * replaces the editor. Off means the file viewer is unchanged. The tables,
	 * endpoints and MCP tool behind it are not gated: nothing in a file changes
	 * until a non-viewer human accepts. Read once, in
	 * `EditableMarkdownStage`. Retire once the review is on for everyone.
	 */
	AGENT_CHANGE_REVIEW: 'agent-change-review',
	/**
	 * Gates the Refresh button on HTML views in the file viewer (bet
	 * [Customizable app: best-practice templates users can reshape or replace with their own views](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/0e9b2ed9-1246-430d-8d2a-b44bbb7a70d5)).
	 * A view that names a list in its maskin-sources block is shown through the data
	 * bridge, and the user's Refresh click fetches the list with their own login.
	 * Frontend only: read once, in `HtmlViewerStage`. Off means the file viewer is
	 * exactly as before: no bridge, no Refresh button. Retire once it is on for
	 * everyone.
	 */
	LIVING_VIEW_REFRESH: 'living-view-refresh',
	/**
	 * Gates undo send in chat: a sent message is held in the client for a few seconds
	 * behind an Undo bar, and nothing is posted until the window ends. Frontend only,
	 * on web and iOS: web reads it once, in `useUndoSend`; iOS reads the same id from
	 * GET /api/feature-flags. Off means a send posts at once, as before. The API is
	 * untouched. Retire once undo send is on for everyone.
	 */
	CHAT_UNDO_SEND: 'chat-undo-send',
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
