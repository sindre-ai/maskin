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
	loopsV4Polish: 'loops-v4-polish',
	loopsV4PolishTargets: 'loops-v4-polish.targets',
	loopsV4PolishStepFlow: 'loops-v4-polish.step_flow',
	loopsV4PolishUnread: 'loops-v4-polish.unread',
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
