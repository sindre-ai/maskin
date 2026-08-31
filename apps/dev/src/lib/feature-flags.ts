// Backend-driven feature flags. Config lives in the apps/dev environment and is
// read at runtime, so turning a feature on for testers (or taking it back
// away) is an env change + restart — never a frontend rebuild. Both vars are
// optional and default to empty, which means every flag is off for everyone.
//
//   FF_TESTER_ACTOR_IDS=<uuid>,<uuid>         actors who see tester features
//   FF_TESTER_FEATURES=some-flag,other-flag   flag ids on for those actors
//
// A flag has exactly two states: off, or on for the tester actors. There is
// deliberately no "on for everyone" setting — shipping a feature to everyone
// means deleting its flag (drop the boundary, delete any legacy branch, remove
// the id from FLAGS below and from FF_TESTER_FEATURES), not parking it in a
// list that only ever grows.
//
// These are deliberately NOT VITE_-prefixed: the tester actor ids stay
// server-side and are never shipped to the browser.

// Every known flag id. Ids absent from this registry always resolve to false,
// so a typo in FF_TESTER_FEATURES can't invent a flag. Add an entry here as the
// first step of introducing a new flag.
export const FLAGS = {
	/**
	 * v2 UI surfaces that have not been tested yet. Off means the pre-v2
	 * rendering under `apps/web/src/components/objects/legacy/`; on means the new
	 * one. Retire it (and delete those directories) once the v2 surfaces have
	 * been through testing — see `.claude/rules/feature-flags.md`.
	 */
	NEW_DESIGN: 'new-design',
	/**
	 * Sales Rep loop's `Draft next LinkedIn touch` step: off means "draft
	 * posted for human review only" (today's behaviour); on means "draft posted
	 * → sent via `linkedin__send_message` with an idempotency key derived from
	 * `(contact_id, draft_id)`". Per-actor, so the workspace admin can opt in
	 * their own Sales Rep driver-actor without flipping every workspace at
	 * once. See the parent bet [First-party LinkedIn MCP — Unipile-backed,
	 * customer-auth](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/56c2ffd7-7e45-448b-a409-c08c15755f9a)
	 * — this flag is the "human-fire path stays available (feature flag on the
	 * loop) so early customers can opt in gradually" gate from the spec's
	 * §Behavioral shape. Behavioural (not visual-layer) — the invocation
	 * surface Task 3 delivers (`linkedin__send_message`) reads this via
	 * `resolveFlags(driverActorId, config)` on each Sales Rep loop tick.
	 * Retire once autosend is the default for every workspace with a
	 * connected `linkedin-unipile` credential.
	 */
	SALES_REP_LINKEDIN_AUTOSEND: 'sales_rep__linkedin_autosend',
} as const

export type FlagId = (typeof FLAGS)[keyof typeof FLAGS]

export interface FeatureFlagConfig {
	/** Lowercased for case-insensitive UUID comparison. */
	testerActorIds: Set<string>
	testerFlags: Set<string>
}

function parseList(raw: string | undefined): string[] {
	if (!raw) return []
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

// `env` is injected so tests never have to mutate process.env — same shape as
// readFallbackConfig() in ./llm-routing.ts.
export function parseFeatureFlagConfig(env: NodeJS.ProcessEnv = process.env): FeatureFlagConfig {
	return {
		testerActorIds: new Set(parseList(env.FF_TESTER_ACTOR_IDS).map((id) => id.toLowerCase())),
		testerFlags: new Set(parseList(env.FF_TESTER_FEATURES)),
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
