// Server-side recommendation engine per Marketplace tech spec §4.
//
// The evaluator is deliberately pure and DB-free — the catalog list handler
// loads workspace state once per request (integrations connected, installed
// loop/agent/skill slugs, human count) into the shape below and calls
// `evaluateRecommendation` per catalog item. Keeping the module pure means:
//   - unit tests do not need a Postgres fixture (see recommendation-engine.test.ts),
//   - the rule vocab from §4.1 is the module's public surface, discoverable
//     from `Predicate` alone,
//   - swapping the caching posture from §4.3 later ("MEMOIZE(workspaceState,
//     60s) in the handler if p95 climbs") never touches this file.
//
// Rejects the spec already resolved (§4.4) — do NOT re-litigate here:
//   - No client-side evaluation. WHY lines are rendered server-side and
//     shipped as strings; the rule bundle never crosses the API boundary.
//   - No learned recommendations / embeddings / per-card LLM inference.
//     Static predicate matching only; first matching rule wins.

/**
 * Snapshot of the workspace state a rule bundle can predicate on. Loaded once
 * per catalog-list request from a handful of small SELECTs; passed by
 * reference to `evaluateRecommendation` for each catalog row.
 *
 * All installed-item maps key on the marketplace catalog slug — that's what
 * `workspace_has_loop: [...]` etc. match against.
 */
export interface WorkspaceState {
	integrations: Set<string>
	installedLoops: Map<string, InstalledItemRef>
	installedAgents: Map<string, InstalledItemRef>
	installedSkills: Map<string, InstalledItemRef>
	humanCount: number
}

export interface InstalledItemRef {
	slug: string
	display_name: string
}

// ── Predicate vocabulary (spec §4.1, verbatim) ────────────────────────────────
//
// Each variant is a discriminated union carrying its own payload; the
// evaluator branches on `in` presence rather than a `kind` discriminator so
// the JSONB shape in the seed manifest reads naturally:
//
//   { "when": { "workspace_has_integration": ["slack"] }, "why": "..." }
//   { "when": { "and": [ ... ] }, "why": "..." }

export type Predicate =
	| { workspace_has_integration: string[] }
	| { workspace_missing_integration: string[] }
	| { workspace_has_loop: string[] }
	| { workspace_missing_loop: string[] }
	| { workspace_has_agent: string[] }
	| { workspace_missing_agent: string[] }
	| { workspace_size_gte: number }
	| { and: Predicate[] }
	| { or: Predicate[] }
	| { not: Predicate }

export interface RecommendationRule {
	when: Predicate
	why: string
}

export interface RecommendationBundle {
	rules?: RecommendationRule[]
	// Added to sort_weight when any rule matches — spec §4.1.
	score_boost?: number
}

/** Populated by whichever positive predicate first matched, so WHY-line
 *  placeholders like `{matched_loop.display_name}` can resolve (spec §4.2). */
export interface MatchContext {
	matched_integration?: string
	matched_loop?: InstalledItemRef
	matched_agent?: InstalledItemRef
}

export interface EvaluatedRecommendation {
	matched: boolean
	why_line?: string
	score_boost: number
}

/**
 * Evaluate a rule bundle against workspace state.
 *
 * First matching rule wins (spec §4.1). If none match, the item still appears
 * in "Popular" / team rails but not "Recommended for you" — WHY line stays
 * empty and `matched` is false (spec §4.2).
 */
export function evaluateRecommendation(
	bundle: RecommendationBundle | undefined | null,
	state: WorkspaceState,
): EvaluatedRecommendation {
	if (!bundle?.rules?.length) return { matched: false, score_boost: 0 }
	for (const rule of bundle.rules) {
		const ctx = evaluatePredicate(rule.when, state)
		if (ctx !== null) {
			return {
				matched: true,
				why_line: renderWhyLine(rule.why, ctx),
				score_boost: bundle.score_boost ?? 0,
			}
		}
	}
	return { matched: false, score_boost: 0 }
}

/**
 * Recursive predicate evaluator. Returns a `MatchContext` on match (possibly
 * empty for predicates that don't bind a placeholder subject, e.g.
 * `workspace_missing_integration` or `workspace_size_gte`), or `null` on
 * mismatch.
 *
 * `and` composes match contexts by merging (last-write-wins on collisions —
 * placeholder authors avoid collisions by using distinct predicate roots);
 * `or` returns the first matching child's context; `not` returns an empty
 * context when the inner predicate does NOT match.
 */
export function evaluatePredicate(pred: Predicate, state: WorkspaceState): MatchContext | null {
	if ('and' in pred) {
		const acc: MatchContext = {}
		for (const child of pred.and) {
			const m = evaluatePredicate(child, state)
			if (m === null) return null
			Object.assign(acc, m)
		}
		return acc
	}
	if ('or' in pred) {
		for (const child of pred.or) {
			const m = evaluatePredicate(child, state)
			if (m !== null) return m
		}
		return null
	}
	if ('not' in pred) {
		return evaluatePredicate(pred.not, state) === null ? {} : null
	}
	if ('workspace_has_integration' in pred) {
		for (const slug of pred.workspace_has_integration) {
			if (state.integrations.has(slug)) return { matched_integration: slug }
		}
		return null
	}
	if ('workspace_missing_integration' in pred) {
		for (const slug of pred.workspace_missing_integration) {
			if (state.integrations.has(slug)) return null
		}
		return {}
	}
	if ('workspace_has_loop' in pred) {
		for (const slug of pred.workspace_has_loop) {
			const found = state.installedLoops.get(slug)
			if (found) return { matched_loop: found }
		}
		return null
	}
	if ('workspace_missing_loop' in pred) {
		for (const slug of pred.workspace_missing_loop) {
			if (state.installedLoops.has(slug)) return null
		}
		return {}
	}
	if ('workspace_has_agent' in pred) {
		for (const slug of pred.workspace_has_agent) {
			const found = state.installedAgents.get(slug)
			if (found) return { matched_agent: found }
		}
		return null
	}
	if ('workspace_missing_agent' in pred) {
		for (const slug of pred.workspace_missing_agent) {
			if (state.installedAgents.has(slug)) return null
		}
		return {}
	}
	if ('workspace_size_gte' in pred) {
		return state.humanCount >= pred.workspace_size_gte ? {} : null
	}
	return null
}

// Two-segment paths only: `{root.field}` per spec §4.2. Bare `{root}` also
// supported when the value is a scalar (e.g. `{matched_integration}`).
const PLACEHOLDER_RE = /\{([a-z_]+(?:\.[a-z_]+)?)\}/g

/**
 * Render a WHY-line template by substituting `{...}` placeholders from the
 * match context. Unresolved placeholders are left as-is (a rule author will
 * catch it on preview; silently blanking them would hide the mistake).
 */
export function renderWhyLine(template: string, ctx: MatchContext): string {
	return template.replace(PLACEHOLDER_RE, (whole, path: string) => {
		const parts = path.split('.')
		if (parts.length === 1) {
			const v = (ctx as Record<string, unknown>)[parts[0]]
			if (typeof v === 'string' || typeof v === 'number') return String(v)
			return whole
		}
		const source = (ctx as Record<string, unknown>)[parts[0]]
		if (source && typeof source === 'object' && parts[1] in (source as object)) {
			const v = (source as Record<string, unknown>)[parts[1]]
			if (typeof v === 'string' || typeof v === 'number') return String(v)
		}
		return whole
	})
}
