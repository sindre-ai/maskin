// Backend-driven feature flags. Config lives in the apps/dev environment and is
// read at runtime, so turning a feature on for testers (or taking it back
// away) is an env change + restart — never a frontend rebuild. All three vars
// are optional and default to empty, which means every flag is off for
// everyone.
//
//   FF_TESTER_ACTOR_IDS=<uuid>,<uuid>          actors who see tester features
//   FF_TESTER_FEATURES=some-flag,other-flag    flag ids on for those tester actors
//   FF_WORKSPACE_FEATURES=<uuid>:<flag>,...    workspace-scoped flag entries
//   FF_SIGNUP_FEATURES=some-flag,other-flag    flag ids on for every NEW sign-up
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
	 * Gates the Daily budget setting in Settings, Billing (bet [A daily token budget,
	 * spent on the right work first](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/0f3ae096-7efc-4412-aba0-7a21a91ba040),
	 * slice 1a). UI only: the route layout reads it once and mounts the section
	 * under the usage banner. Off means Billing looks as it does today. The
	 * storage and API behind it are additive and safe with the flag off. Retire
	 * once the daily budget is on for everyone.
	 */
	DAILY_BUDGET: 'daily-budget',
	/**
	 * Gates editing a draft's text in place on the web For You card, with Send saving the
	 * edit and approving the saved text in one step. Frontend only: read with useFeatureFlag
	 * in draft-preview. Retire once editing is on for everyone.
	 */
	FORYOU_DRAFT_EDIT: 'foryou-draft-edit',
	/**
	 * Gates the Edit action on your own comments on a task, bet or insight in the web app. Frontend
	 * only: read with useFeatureFlag in activity-comment. Off means a comment shows no Edit button.
	 * The edit route behind it only changes a comment's text for its author and is safe with the
	 * flag off. Retire once editing is on for everyone.
	 */
	COMMENT_EDIT: 'comment-edit',
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
	 * Gates formatting in chat messages you write: bold, lists, quotes, code and tables in your
	 * own sent messages draw formatted, as other people's already do. Frontend only: read once,
	 * in `MessageBubble`. Off means your own message is drawn exactly as before. The chat typing
	 * box formatting reads the same id. Retire once it is on for everyone.
	 */
	CHAT_FORMATTING: 'chat-formatting',
	/**
	 * Gates waking a driver when something it drives changes (bet [Agents take the lead](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/1a8c343f-7fda-4940-8d73-750f307984ef),
	 * rule 4): its child tasks all close, a blocker clears, its own object is moved by someone
	 * else, or a decision card it posted expires. Backend only, workspace-scoped: read with
	 * isFlagEnabledForWorkspace in services/driver-wake.ts. Off means no wake is started and
	 * nothing is recorded. Turn on only after the self-start limits (cap, back-off and daily
	 * budget) are live, because they are the only brake on a wake. Retire once the wake is on for
	 * everyone.
	 */
	DRIVER_WAKE: 'driver-wake',
	/**
	 * Gates the sweep for overdue or missing next steps (bet [Agents take the lead](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/1a8c343f-7fda-4940-8d73-750f307984ef),
	 * rule 4, fallback half). Backend only, workspace-scoped: read with isFlagEnabledForWorkspace
	 * in services/next-step-sweep.ts, and the sweep only visits workspaces named in
	 * FF_WORKSPACE_FEATURES. On means the sweep runs in RECORD-ONLY mode: it writes what it would
	 * have woken and starts nothing. Off (the default) means the sweep does not look at the
	 * workspace and writes nothing. Nothing here starts a run until NEXT_STEP_SWEEP_WAKE is on too.
	 */
	NEXT_STEP_SWEEP: 'next-step-sweep',
	/**
	 * Lets the sweep start runs. Needs NEXT_STEP_SWEEP on for the workspace, and the sweep must
	 * have been recording for at least 3 days (the first-run flood guard). Turn on only after the
	 * would-wake list was compared with what is really stuck and the self-start limits are live.
	 */
	NEXT_STEP_SWEEP_WAKE: 'next-step-sweep-wake',
	/**
	 * Gates the item card beside a loop view (bet [Act on items inside loop views](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d9bdf0fe-d570-4c0f-93d9-744e18def585)):
	 * when a view asks to open an item, the loop page shows its card in a side panel, where the
	 * person can change its status or approve it, instead of going to the object's page. Frontend
	 * only: read once, in `LoopViewTab`. Off means Open goes to the object's page as before. Retire
	 * once it is on for everyone.
	 */
	LOOP_VIEW_ITEM_PANEL: 'loop-view-item-panel',
	/**
	 * Gates date and time changes from a loop view (bet [Act on items inside loop views](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d9bdf0fe-d570-4c0f-93d9-744e18def585)):
	 * when a view proposes a new day or post time for an item, the loop page asks the person
	 * "Move to 14 Nov?" and saves only after they confirm. Frontend only: read once, in
	 * `LoopViewTab`. Off means a view's proposal is ignored and nothing can be changed from a view.
	 * Retire once it is on for everyone.
	 */
	LOOP_VIEW_DATE_CHANGE: 'loop-view-date-change',
	/**
	 * Gates Export in the three-dot menu of a custom view: Markdown, PDF or PNG of what the view
	 * shows now, built in the browser and saved by the person's click (task [Export a view as
	 * Markdown, PDF or PNG](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/e5494586-905b-4845-80d8-33314a419635)).
	 * Frontend only: read once, in `LoopViewTab`. Off means the menu has no Export. Retire once it
	 * is on for everyone.
	 */
	LOOP_VIEW_EXPORT: 'loop-view-export',
	/**
	 * Gates the default on silence for decision cards (bet [Agents take the lead](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/1a8c343f-7fda-4940-8d73-750f307984ef),
	 * task [Let decision cards carry a default on silence](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/bcfed848-7a51-418e-a5d0-172999385c9c)).
	 * Backend only, workspace-scoped: read with isFlagEnabledForWorkspace in routes/events.ts
	 * (off means a card that names a default is refused, so no agent is promised a wake that
	 * never comes) and in services/decision-default-wake.ts (off means no wake is started). The
	 * card line on web and iOS only draws for a card that names a default. Turn on only after the
	 * self-start limits (cap, back-off and daily budget) are live, because the wake goes through
	 * them. Retire once it is on for everyone.
	 */
	DECISION_DEFAULT: 'decision-default',
	/**
	 * Gates undo send in chat: a sent message is held in the client for a few seconds
	 * behind an Undo bar, and nothing is posted until the window ends. Frontend only: web reads
	 * it once, in `useUndoSend`, and iOS reads it from `GET /api/feature-flags` (`FeatureFlagID`).
	 * Off means a send posts at once, as before. The API is untouched. Retire once undo send is
	 * on for everyone.
	 */
	CHAT_UNDO_SEND: 'chat-undo-send',
	/**
	 * Gates the mail to the billing owner when a workspace uses up its plan (task [Email when a
	 * workspace uses up its plan](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/456ff70b-5c4a-4e2a-80c6-fded357ea84a)).
	 * Backend only, workspace-scoped: read with isFlagEnabledForWorkspace in
	 * services/plan-limit-email.ts before anything is stored or sent. Off means no mail and no
	 * row, so a workspace that is already over its limit when this ships is not mailed; only a
	 * refusal or stop after the flag is on counts. Turned on by a person after the wording is
	 * approved. Retire once it is on for everyone.
	 */
	PLAN_LIMIT_EMAIL: 'plan-limit-email',
	/**
	 * Gates the new chat list on web (bet [Chat list: date groups, attention markers, filter
	 * search](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/57d0ac81-c1c3-4e5f-9a70-b0bcb941945e)).
	 * UI only, actor-scoped: the Chats route layout reads it once and swaps the list column. Off
	 * means the list looks as it does today. The server's new list fields are additive and safe for
	 * everyone without it. Retire once the new list is on for everyone.
	 */
	CHAT_LIST_V2: 'chat-list-v2',
	/**
	 * Gates the Create view with agent item in the menus on the Items list, an item's page and
	 * a flow page (task [Add Create view with agent menu item](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/93b3749a-d33d-4d67-9513-4a79c11fc83c)).
	 * Frontend only, actor-scoped: read with useFeatureFlag in use-create-view-with-agent. Off
	 * means the three menus look as they do today. The chat it opens, pinned files and flow
	 * views are existing features and are not gated. Retire once the item is on for everyone.
	 */
	CREATE_VIEW_WITH_AGENT: 'create-view-with-agent',
	/**
	 * Gates the Send permissions screen under Settings, where a human admin or owner sets
	 * Always allow, Ask first or Deny per agent and draft kind. Frontend only: read with
	 * useFeatureFlag in the settings layout (the nav entry) and the route. The send gate and
	 * the settings API are not flagged, they read the saved settings. Retire once the screen
	 * is on for everyone.
	 */
	SEND_PERMISSIONS_SCREEN: 'send-permissions-screen',
	/**
	 * Gates the agents in the top row of the iOS share sheet (task [Agents show as people in the iOS share sheet](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/e7484a53-3495-4654-b7c3-bded62fb9348)).
	 * iOS app only, actor-scoped: read by AppRuntime before the app donates an agent to iOS. Off
	 * means nothing new is donated and the row shows what it shows today. Retire once the row is
	 * on for everyone.
	 */
	IOS_SHARE_SUGGESTIONS: 'ios-share-suggestions',
	/**
	 * Gates the Azure DevOps integration (task [Add Azure DevOps integration](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/508145fe-70aa-497c-a08a-d37e76f90c82)).
	 * Actor-scoped, read by the integrations routes: off means the provider is missing from
	 * GET /api/integrations/providers and its connect call is refused, so Settings shows nothing
	 * new. A workspace that is already connected keeps working through the gateway. Retire once
	 * the Entra app registration is approved for customers and the provider is on for everyone.
	 */
	AZURE_DEVOPS: 'azure-devops',
	/**
	 * Gates the Zoom integration (task [Add Zoom integration](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/db07585a-26e3-462f-b73e-e2690e0f142b)).
	 * Actor-scoped, read by the integrations routes: off means the provider is missing from
	 * GET /api/integrations/providers and its connect call is refused, so Settings shows nothing
	 * new. A workspace that is already connected keeps working through the gateway. Retire once
	 * the Zoom Marketplace app is approved for customers and the provider is on for everyone.
	 */
	ZOOM: 'zoom',
	/**
	 * Gates the four meeting-notes integrations Fireflies, Granola, Fathom and Otter (task
	 * [Add four meeting-notes integrations](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/7bfb4736-6c21-4cc9-9a19-2e6f8f4d35d6)).
	 * Actor-scoped, read by the integrations routes: off means the four are missing from
	 * GET /api/integrations/providers and their connect call is refused, so Settings shows nothing
	 * new. A workspace that is already connected keeps working through the gateway. Retire once a
	 * real sign-in has worked for each and the providers are on for everyone.
	 */
	MEETING_NOTES_INTEGRATIONS: 'meeting-notes-integrations',
	/**
	 * Gates the ten developer and data integrations Cloudflare, Supabase, Neon, PlanetScale, Netlify,
	 * Datadog, New Relic, PagerDuty, Retool and Hex (task
	 * [Add developer and data integrations](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/a0ecefc6-7add-4653-8157-d6e83ea2163d)).
	 * Actor-scoped, read by the integrations routes: off means the ten are missing from
	 * GET /api/integrations/providers and their connect call is refused, so Settings shows nothing
	 * new. A workspace that is already connected keeps working through the gateway. Retire once a
	 * real sign-in has worked for each and the providers are on for everyone.
	 */
	DEVELOPER_DATA_INTEGRATIONS: 'developer-data-integrations',
	/**
	 * Gates the eight sales and automation integrations Apollo, ZoomInfo, Outreach, Gong, Clay,
	 * Calendly, monday.com and Make (task
	 * [Add sales and automation integrations](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/18a0ef4c-3cd5-468e-a8cb-3ea3b3344599)).
	 * Actor-scoped, read by the integrations routes: off means the eight are missing from
	 * GET /api/integrations/providers and their connect call is refused, so Settings shows nothing
	 * new. A workspace that is already connected keeps working through the gateway. Retire once a
	 * real sign-in has worked for each and the providers are on for everyone.
	 */
	SALES_AUTOMATION_INTEGRATIONS: 'sales-automation-integrations',
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
	/**
	 * Flag ids on for every new sign-up, sourced from `FF_SIGNUP_FEATURES`. A person who has not
	 * signed up yet cannot be named in `FF_TESTER_ACTOR_IDS`, so a sign-up-time feature (the card
	 * step) needs a list that is not keyed by actor. Read only by `isSignupFlagEnabled`.
	 */
	signupFeatures: Set<string>
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
		signupFeatures: new Set(parseList(env.FF_SIGNUP_FEATURES)),
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

/**
 * Whether a flag is on for the sign-up happening right now. Not tied to an actor or a workspace:
 * the person does not exist yet when the sign-up route decides. Unknown flag ids (typos, ids not
 * in the registry) always resolve to false.
 */
export function isSignupFlagEnabled(
	flagId: string,
	flagConfig: FeatureFlagConfig = getFeatureFlagConfig(),
	registry: Record<string, string> = FLAGS,
): boolean {
	if (!Object.values(registry).includes(flagId)) return false
	return flagConfig.signupFeatures.has(flagId)
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
