/**
 * Static map `triggerKind → requiredIntegrations[]` consumed by:
 *  - **LoopPlanCard** (D9 NEEDS THESE CONNECTED row on /loops/new)
 *  - **trigger-runner** create-time validation (future).
 *
 * Bet SPEC Q3 pins the shape as a shared static map for the frontend, promoted
 * to a server endpoint only when the map churns. Keys are the trigger `type`
 * values from **triggerTypeSchema** (**cron** | **event** | **reminder**).
 *
 * Task 1 (Land shared loop helper modules) will expand this file with feature
 * flag scaffolding + waiting-on-viewer.ts. This D9 pass landed the module
 * because Task 1 hadn't cut a branch yet — the exports below are stable
 * (both `TRIGGER_KIND_INTEGRATIONS` and `getRequiredIntegrationsForPlanTrigger`
 * are what consumers import). If Task 1's PR updates the map, keep those
 * export names.
 */

/** Provider names align with **ProviderInfo.name** returned by
 *  **GET /integrations/providers**, so the frontend can look them up in one
 *  step. */
export type ProviderName = string

/** The set of trigger kinds today (matches **triggerTypeSchema**). SPEC says
 *  "four kinds"; only three are enumerated in schemas today — flagged in the
 *  D9 PR so Task 1 can reconcile.  */
export type TriggerKind = 'cron' | 'event' | 'reminder'

/** By kind, integrations that must be connected before any trigger of that
 *  kind can fire. `event` triggers may need one of many providers depending on
 *  the `entity_type` — inference for that lives in
 *  **getRequiredIntegrationsForPlanTrigger** since the map is static per
 *  SPEC Q3. */
export const TRIGGER_KIND_INTEGRATIONS: Record<TriggerKind, ProviderName[]> = {
	cron: [],
	event: [],
	reminder: [],
}

/** Keywords that appear in the plan's freeform **whenClause** or the
 *  trigger's target agent, mapped to the provider they imply. Providers not
 *  configured on the server are ignored downstream (**LoopPlanCard** drops
 *  any provider whose name isn't in the workspace's provider list). */
const CLAUSE_KEYWORD_TO_PROVIDER: Array<{ keywords: string[]; provider: ProviderName }> = [
	{ keywords: ['slack'], provider: 'slack' },
	{ keywords: ['github', 'pull request', 'pr merged', 'commit'], provider: 'github' },
	{ keywords: ['linear'], provider: 'linear' },
	{ keywords: ['hubspot', 'pipeline'], provider: 'hubspot' },
	{ keywords: ['posthog'], provider: 'posthog' },
	{ keywords: ['skjald', 'transcript'], provider: 'skjald' },
	{ keywords: ['stripe'], provider: 'stripe' },
	{ keywords: ['notion'], provider: 'notion' },
]

export interface PlanTriggerLike {
	/** The plan's UI-level kind label (**EVENT** | **RECURRING** | **NOTIFY**)
	 *  — LoopPlan carries these, not the raw schema type. Kept optional so
	 *  callers with the raw type can pass that instead. */
	kindLabel?: string
	whenClause?: string
	targetAgent?: string
}

/** Map a LoopPlan trigger's UI kind label to the schema `TriggerKind` so the
 *  static map can be indexed. Unknown labels fall through as `event`, the
 *  most conservative default (event triggers may require any provider). */
export function normalizeTriggerKindLabel(label: string | undefined): TriggerKind {
	const value = (label ?? '').toLowerCase()
	if (value === 'recurring' || value === 'cron') return 'cron'
	if (value === 'reminder') return 'reminder'
	return 'event'
}

/** Deduped list of provider names required to run this plan trigger. Combines:
 *  1. Static per-kind requirements from `TRIGGER_KIND_INTEGRATIONS`.
 *  2. Content inference on the trigger's `whenClause` + `targetAgent` — a
 *     sentence like "when someone slacks me…" needs the slack provider even
 *     though the plan doesn't carry the raw `entity_type`. */
export function getRequiredIntegrationsForPlanTrigger(trigger: PlanTriggerLike): ProviderName[] {
	const kind = normalizeTriggerKindLabel(trigger.kindLabel)
	const providers = new Set<ProviderName>(TRIGGER_KIND_INTEGRATIONS[kind])
	const haystack = `${trigger.whenClause ?? ''} ${trigger.targetAgent ?? ''}`.toLowerCase()
	for (const { keywords, provider } of CLAUSE_KEYWORD_TO_PROVIDER) {
		if (keywords.some((k) => haystack.includes(k))) providers.add(provider)
	}
	return Array.from(providers)
}

/** Deduped list across every trigger in a plan. Ordering preserved from the
 *  first mention across triggers — important for the footer sentence, which
 *  reads them left-to-right. */
export function getRequiredIntegrationsForPlan(triggers: PlanTriggerLike[]): ProviderName[] {
	const providers: ProviderName[] = []
	const seen = new Set<ProviderName>()
	for (const trigger of triggers) {
		for (const provider of getRequiredIntegrationsForPlanTrigger(trigger)) {
			if (seen.has(provider)) continue
			seen.add(provider)
			providers.push(provider)
		}
	}
	return providers
}
