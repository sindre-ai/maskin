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
// The `loops-v4-polish.*` sub-flags let a single Loops & Loop detail v4 delta be
// reverted without dropping the rest: `.targets` for D5 (Loop targets) and
// `.unread` for D8 (unread boundary + Mark read). See
// `.claude/rules/feature-flags.md` for the boundary rule.
export const FLAGS = {
	loopsV4PolishTargets: 'loops-v4-polish.targets',
	loopsV4PolishUnread: 'loops-v4-polish.unread',
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
	/**
	 * Gates the daily capability scan (bet
	 * [Agents look through connected integrations for new things they can do](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/3dae5ff5-7c94-41ee-8687-0023b37994f2)).
	 * Workspace-scoped, read with `isFlagEnabledForWorkspace` in
	 * `services/capability-scanner.ts`. Off means no scanner work and no
	 * `capability_*` event is written. On ({workspaceId}:capability-scan in
	 * `FF_WORKSPACE_FEATURES`, then restart) the scan runs in shadow mode: it
	 * writes snapshots and findings as events and messages nobody. Backend only,
	 * no UI reads it. Retire once the scan is on for every workspace.
	 */
	CAPABILITY_SCAN: 'capability-scan',
	/**
	 * Gates agent-started messages in a person's 1-1 chat (bet
	 * [Agents look through connected integrations for new things they can do](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/3dae5ff5-7c94-41ee-8687-0023b37994f2)).
	 * Actor-scoped on the RECIPIENT, read with `isFlagEnabled(recipientId, ...)`
	 * in `services/proactive-message.ts`. Off means `sendProactiveMessage` refuses
	 * with flag_off and nobody is messaged; the capability scan keeps running in
	 * shadow mode. Rollout: the tester's actor id in `FF_TESTER_ACTOR_IDS` and
	 * this id in `FF_TESTER_FEATURES`, then restart. Backend only, no UI reads it.
	 * Retire once agent-started notes are on for everyone.
	 */
	AGENT_PROACTIVE_1_1: 'agent-proactive-1-1',
	/**
	 * Unipile webhook deliveries become `events` rows (message.new first). Read
	 * per integration row on the dedicated linkedin-unipile webhook route, on the
	 * integration's owner actor (actor_id, falling back to created_by), after
	 * account resolution and before the dedupe claim. Off means a signed
	 * delivery is acknowledged with `skipped: flag_off` and nothing is written,
	 * so switching it on later needs no replay. A rollout gate, not a kill
	 * switch (env + restart); the fast stop is disabling the trigger. Retire
	 * once the Unipile webhook events bet is won. See parent bet [Unipile webhook
	 * events as triggers](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/756e1cbe-9933-4fe2-a3fd-d95ce6497044).
	 */
	LINKEDIN_UNIPILE_EVENTS: 'linkedin-unipile-events',
	/**
	 * Makes a "needs you" push rarer and clearer for the flagged person. Read per
	 * RECIPIENT in `services/notification-push.ts`. Off is today's behaviour. On:
	 *  - a plain @mention comment (no decision block) stays in the app, no push
	 *  - a push about an object replaces the earlier push about that object
	 *  - `metadata.due_at` puts "Before <time>" at the start of the push text
	 * The rules live in `evaluatePush` (`services/push-policy.ts`). Rollout: the
	 * tester's actor id in `FF_TESTER_ACTOR_IDS` and this id in
	 * `FF_TESTER_FEATURES`, then restart. Backend only. Retire once it is on for
	 * everyone: drop the `gate` input and keep the rules.
	 */
	PUSH_HUMAN_DECISIONS_ONLY: 'push-human-decisions-only',
	/**
	 * Gates the LinkedIn outreach writes: withdraw_invitation, react_to_post, send_inmail and
	 * any send whose approved object carries a file (`attachment_file_id`). Read per call on
	 * the workspace, with the calling actor as fallback. Off means a send with a file is
	 * refused with INVALID_INPUT; plain text sends are unaffected. See parent bet [Sales Reps
	 * close the LinkedIn outreach loop](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/aff468ba-2519-4401-836e-2251c9560e5b).
	 * Retire once the outreach tools are on for everyone.
	 */
	LINKEDIN_OUTREACH_ACTIONS: 'linkedin-outreach-actions',
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
