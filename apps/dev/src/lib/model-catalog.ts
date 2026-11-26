/**
 * Platform-owned catalog of the models an agent may be set to. Stored in code,
 * not per workspace: adding a model is a reviewed change, because the choice
 * decides which outside provider sees an agent's prompts and, on the funded
 * route, which models spend Maskin's OpenRouter key.
 *
 * Each entry belongs to one route kind:
 *   - subscription: a Claude model, run through the workspace's Claude
 *     subscription (enterprise workspaces only).
 *   - openrouter: a model served by Maskin's funded OpenRouter account
 *     (never reachable from an enterprise workspace — the billing guard in
 *     llm-routing.ts stays as it is).
 *
 * Tiers are aliases into the catalog: one entry per tier and route kind.
 */

export const MODEL_TIERS = ['smartest', 'standard', 'fast', 'efficient'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/** The tier an agent runs on when it names no model. */
export const DEFAULT_MODEL_TIER: ModelTier = 'standard'

export type CatalogRoute = 'subscription' | 'openrouter'

export interface CatalogModel {
	/** The id sent as ANTHROPIC_MODEL, and the value stored in llm_config.model. */
	id: string
	displayName: string
	route: CatalogRoute
	/** The tier this entry backs on its route kind. */
	tier: ModelTier
	/** True only where Maskin has seen the model complete real tool-use sessions. */
	toolUseProven: boolean
	/** Who sees the agent's prompts, in one plain sentence. */
	dataHandling: string
	/** Where the price comes from, so a cost question has a place to start. */
	priceSource: string
	/** The model for the CLI's background calls. Set together with the main model. */
	smallFastModel: string
	/** Passed to the CLI as --effort. Unset leaves the CLI default. */
	effort?: 'low' | 'medium' | 'high'
	/** Funded route: send MAX_THINKING_TOKENS=0 (drops the thinking field). */
	thinkingOff?: boolean
	/** Funded route: restrict serving to MASKIN_FALLBACK_PROVIDER_ONLY hosts. */
	providerAllowList?: boolean
}

const CLAUDE_SMALL_FAST_MODEL = 'claude-haiku-4-5-20251001'

export const FUNDED_DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash'

export const MODEL_CATALOG: readonly CatalogModel[] = [
	{
		id: 'claude-opus-5-5',
		displayName: 'Claude Opus 5.5',
		route: 'subscription',
		tier: 'smartest',
		toolUseProven: false,
		dataHandling: "Sent to Anthropic under the workspace's own Claude subscription.",
		priceSource: "Covered by the workspace's Claude subscription; the CLI reports list price.",
		smallFastModel: CLAUDE_SMALL_FAST_MODEL,
		effort: 'high',
	},
	{
		id: 'claude-sonnet-5-5',
		displayName: 'Claude Sonnet 5.5',
		route: 'subscription',
		tier: 'standard',
		toolUseProven: true,
		dataHandling: "Sent to Anthropic under the workspace's own Claude subscription.",
		priceSource: "Covered by the workspace's Claude subscription; the CLI reports list price.",
		smallFastModel: CLAUDE_SMALL_FAST_MODEL,
		effort: 'high',
	},
	{
		id: CLAUDE_SMALL_FAST_MODEL,
		displayName: 'Claude Haiku 4.5',
		route: 'subscription',
		tier: 'fast',
		toolUseProven: false,
		dataHandling: "Sent to Anthropic under the workspace's own Claude subscription.",
		priceSource: "Covered by the workspace's Claude subscription; the CLI reports list price.",
		smallFastModel: CLAUDE_SMALL_FAST_MODEL,
	},
	{
		id: FUNDED_DEFAULT_MODEL,
		displayName: 'DeepSeek V4.1 Flash',
		route: 'openrouter',
		tier: 'standard',
		toolUseProven: true,
		dataHandling:
			"Sent through Maskin's OpenRouter account to the hosts in MASKIN_FALLBACK_PROVIDER_ONLY.",
		priceSource: 'OpenRouter models list (prompt and completion price per token).',
		smallFastModel: FUNDED_DEFAULT_MODEL,
		// With the CLI default, about 70% of a session's output was hidden
		// reasoning (Claude: about 30%), one think ran 2m37s with nothing on screen.
		// Effort alone does not fix that: DeepSeek maps low and medium to high, and
		// the CLI still asks for adaptive thinking. MAX_THINKING_TOKENS=0 drops the
		// thinking field from the request, which is what stops the reasoning. Low
		// effort stays as the secondary setting.
		effort: 'low',
		thinkingOff: true,
		providerAllowList: true,
	},
]

/**
 * Context windows of non-Claude models, by a lowercase fragment of the model
 * id. The Claude CLI only knows the windows of Claude models: for any other id
 * it assumes 200,000 tokens, so a 1M-token model compacts five times too early
 * and, with a large fixed prompt, can refill its window within a few turns.
 * Matched on a fragment so OpenRouter ids ("deepseek/deepseek-v4.1-flash") and
 * bare ids on a bring-your-own endpoint ("deepseek-v4-flash") both resolve.
 */
const KNOWN_CONTEXT_WINDOWS: readonly { match: string; tokens: number }[] = [
	{ match: 'deepseek-v4', tokens: 1_000_000 },
]

/** The CLI window for a model it does not know; 1M is only reached with the [1m] suffix. */
export const EXTENDED_CONTEXT_TOKENS = 1_000_000

/** The context window Maskin knows for a model id, or undefined when it does not. */
export function knownContextWindow(id: string | null | undefined): number | undefined {
	if (!id) return undefined
	const lower = id.toLowerCase()
	return KNOWN_CONTEXT_WINDOWS.find((m) => lower.includes(m.match))?.tokens
}

/**
 * The value to send as ANTHROPIC_MODEL. The CLI reads a trailing "[1m]" as
 * "this model has a 1M-token window" and strips it before the request goes
 * out, so the provider still sees the plain id. Only the main model gets it:
 * the name stamped on the session and priced stays the plain id.
 */
export function withContextWindow(id: string): string {
	const tokens = knownContextWindow(id)
	if (!tokens || tokens < EXTENDED_CONTEXT_TOKENS || /\[1m\]$/i.test(id)) return id
	return `${id}[1m]`
}

export function getCatalogModel(id: string | null | undefined): CatalogModel | undefined {
	if (!id) return undefined
	return MODEL_CATALOG.find((m) => m.id === id)
}

/** The entry a tier points at on a route kind. */
export function tierModel(tier: ModelTier, route: CatalogRoute): CatalogModel | undefined {
	return MODEL_CATALOG.find((m) => m.tier === tier && m.route === route)
}

/** The route kind a workspace can reach: enterprise never reaches the funded route. */
export function routeKindFor(enterprise: boolean): CatalogRoute {
	return enterprise ? 'subscription' : 'openrouter'
}

export function listRoutableModels(enterprise: boolean): CatalogModel[] {
	const kind = routeKindFor(enterprise)
	return MODEL_CATALOG.filter((m) => m.route === kind)
}
