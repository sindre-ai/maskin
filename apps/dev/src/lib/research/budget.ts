import type { LLMUsage } from '../llm/adapter'
import type { ModelPricing } from '../openrouter-pricing'

/**
 * The cost meter for one deep_research run (spec section 7.3). All money inside
 * is micro-USD (1 USD = 1_000_000) so the provider's fractions of a cent add up
 * without float drift. `spentCents` rounds up, so the stored cost is never below
 * what was spent.
 *
 * Reserve before work starts: writer 15%, lead 5%, researchers share the rest
 * equally. A simple run has no lead call, so its researcher gets the lead's 5%.
 */
const WRITER_SHARE = 0.15
const LEAD_SHARE = 0.05
/** Past this fraction of the cap, researchers stop at their next call boundary. */
const RESEARCH_STOP_FRACTION = 0.85

const MICRO_USD_PER_CENT = 10_000

export type BudgetStage = 'lead' | 'writer' | `researcher:${number}`

export class UnpricedModelError extends Error {
	constructor(model: string) {
		super(`Model ${model} is not in the price table, so the run cannot be metered`)
		this.name = 'UnpricedModelError'
	}
}

/** A run refuses to start on a model with no price: there are no unmetered runs. */
export function requireModelPricing(model: string, pricing: ModelPricing | null): ModelPricing {
	if (!pricing) throw new UnpricedModelError(model)
	return pricing
}

/** What one LLM call cost, from the provider's reported usage. */
export function llmCostMicroUsd(usage: LLMUsage, pricing: ModelPricing): number {
	const usd =
		usage.input_tokens * pricing.prompt +
		usage.output_tokens * pricing.completion +
		usage.cache_read_input_tokens * pricing.cacheRead +
		usage.cache_creation_input_tokens * pricing.cacheWrite
	return Math.ceil(usd * 1_000_000)
}

/**
 * The most one call could cost: every input token at the full prompt rate, and
 * the whole max_tokens produced. Used to decide whether a call still fits.
 */
export function worstCaseLlmMicroUsd(
	inputTokens: number,
	maxTokens: number,
	pricing: ModelPricing,
): number {
	return Math.ceil((inputTokens * pricing.prompt + maxTokens * pricing.completion) * 1_000_000)
}

export class RunBudget {
	private readonly capMicroUsd: number
	private readonly shares = new Map<BudgetStage, number>()
	private readonly spent = new Map<BudgetStage, number>()
	private searches = 0
	private extracts = 0

	constructor(opts: { capCents: number; researchers: number; hasLead: boolean }) {
		if (!Number.isInteger(opts.capCents) || opts.capCents <= 0) {
			throw new RangeError('capCents must be a positive whole number')
		}
		if (!Number.isInteger(opts.researchers) || opts.researchers <= 0) {
			throw new RangeError('researchers must be a positive whole number')
		}
		this.capMicroUsd = opts.capCents * MICRO_USD_PER_CENT

		const leadShare = opts.hasLead ? LEAD_SHARE : 0
		const researcherShare = (1 - WRITER_SHARE - leadShare) / opts.researchers
		this.shares.set('writer', Math.round(WRITER_SHARE * this.capMicroUsd))
		if (opts.hasLead) this.shares.set('lead', Math.round(LEAD_SHARE * this.capMicroUsd))
		for (let i = 0; i < opts.researchers; i++) {
			this.shares.set(`researcher:${i}`, Math.round(researcherShare * this.capMicroUsd))
		}
	}

	/** Adds a cost to a stage. Returns the new total in micro-USD. */
	record(stage: BudgetStage, microUsd: number): number {
		if (!this.shares.has(stage)) throw new RangeError(`unknown budget stage ${stage}`)
		if (!Number.isFinite(microUsd) || microUsd < 0) throw new RangeError('cost must be >= 0')
		this.spent.set(stage, (this.spent.get(stage) ?? 0) + microUsd)
		return this.totalMicroUsd
	}

	recordLlm(stage: BudgetStage, usage: LLMUsage, pricing: ModelPricing): void {
		this.record(stage, llmCostMicroUsd(usage, pricing))
	}

	recordSearch(stage: BudgetStage, microUsd: number): void {
		this.searches += 1
		this.record(stage, microUsd)
	}

	/** `pages` is how many URLs came back with text, the ones that were billed. */
	recordExtract(stage: BudgetStage, microUsd: number, pages: number): void {
		this.extracts += pages
		this.record(stage, microUsd)
	}

	/**
	 * True when a call that could cost up to `worstCaseMicroUsd` still fits the
	 * stage's reserved share. A researcher told "no" stops and returns what it has.
	 */
	canAfford(stage: BudgetStage, worstCaseMicroUsd: number): boolean {
		const share = this.shares.get(stage)
		if (share === undefined) throw new RangeError(`unknown budget stage ${stage}`)
		return (this.spent.get(stage) ?? 0) + worstCaseMicroUsd <= share
	}

	/** True once researchers should stop before the writer starts. */
	get researchExhausted(): boolean {
		return this.totalMicroUsd >= RESEARCH_STOP_FRACTION * this.capMicroUsd
	}

	get totalMicroUsd(): number {
		let total = 0
		for (const v of this.spent.values()) total += v
		return total
	}

	/** Rounded up to a whole cent, for research_runs.cost_cents. */
	get spentCents(): number {
		return Math.ceil(this.totalMicroUsd / MICRO_USD_PER_CENT)
	}

	get searchCount(): number {
		return this.searches
	}

	get extractCount(): number {
		return this.extracts
	}

	/** Micro-USD still free in the stage's own share, never below zero. */
	remainingMicroUsd(stage: BudgetStage): number {
		const share = this.shares.get(stage)
		if (share === undefined) throw new RangeError(`unknown budget stage ${stage}`)
		return Math.max(0, share - (this.spent.get(stage) ?? 0))
	}

	/** Per-stage spend in cents, for research_runs.stages. */
	stageCostCents(): Record<string, number> {
		const out: Record<string, number> = {}
		for (const [stage, v] of this.spent) out[stage] = Math.ceil(v / MICRO_USD_PER_CENT)
		return out
	}
}
