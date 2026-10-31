import { describe, expect, it } from 'vitest'
import {
	RunBudget,
	UnpricedModelError,
	llmCostMicroUsd,
	requireModelPricing,
	worstCaseLlmMicroUsd,
} from '../../../lib/research/budget'

// $1 per million input tokens, $5 per million output, cache read $0.10, cache write $1.25.
const pricing = {
	prompt: 0.000001,
	completion: 0.000005,
	cacheRead: 0.0000001,
	cacheWrite: 0.00000125,
}
const usage = (o: Partial<Record<string, number>> = {}) => ({
	input_tokens: 0,
	output_tokens: 0,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
	...o,
})

describe('llmCostMicroUsd', () => {
	it('prices each token bucket at its own rate', () => {
		const cost = llmCostMicroUsd(
			usage({
				input_tokens: 1_000_000,
				output_tokens: 100_000,
				cache_read_input_tokens: 1_000_000,
				cache_creation_input_tokens: 100_000,
			}),
			pricing,
		)
		// 1.00 + 0.50 + 0.10 + 0.125 USD
		expect(cost).toBe(1_725_000)
	})

	it('is zero when the provider reported no usage', () => {
		expect(llmCostMicroUsd(usage(), pricing)).toBe(0)
	})
})

describe('worstCaseLlmMicroUsd', () => {
	it('assumes all input at the prompt rate and the whole max_tokens produced', () => {
		expect(worstCaseLlmMicroUsd(10_000, 2_000, pricing)).toBe(20_000)
	})
})

describe('requireModelPricing', () => {
	it('refuses a model with no price', () => {
		expect(() => requireModelPricing('mystery/model', null)).toThrow(UnpricedModelError)
	})

	it('returns the price when there is one', () => {
		expect(requireModelPricing('m', pricing)).toBe(pricing)
	})
})

describe('RunBudget', () => {
	it('rounds the spend up to a whole cent so the stored cost is never low', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 1, hasLead: false })
		budget.recordSearch('researcher:0', 8_000) // 0.8 cent
		expect(budget.spentCents).toBe(1)
		budget.recordSearch('researcher:0', 8_000) // 1.6 cents in total
		expect(budget.spentCents).toBe(2)
		expect(budget.searchCount).toBe(2)
	})

	it('counts the pages billed by an extract call', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 1, hasLead: false })
		budget.recordExtract('researcher:0', 3_200, 2)
		expect(budget.extractCount).toBe(2)
	})

	it('gives the writer 15% and a simple-run researcher the other 85%', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 1, hasLead: false })
		// 100 cents = 1_000_000 micro-USD.
		expect(budget.remainingMicroUsd('writer')).toBeCloseTo(150_000)
		expect(budget.remainingMicroUsd('researcher:0')).toBeCloseTo(850_000)
	})

	it('reserves 5% for the lead and splits the rest between researchers', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 4, hasLead: true })
		expect(budget.remainingMicroUsd('lead')).toBeCloseTo(50_000)
		expect(budget.remainingMicroUsd('researcher:3')).toBeCloseTo(200_000)
	})

	it('splits 80% equally between 12 researchers once the lead has picked the count', () => {
		// 1200 cents = 12_000_000 micro-USD: writer 1_800_000, lead 600_000, researchers 9_600_000.
		const budget = new RunBudget({ capCents: 1200, researchers: 2, hasLead: true })
		budget.assignResearchers(12)
		for (let i = 0; i < 12; i++) {
			expect(budget.remainingMicroUsd(`researcher:${i}`)).toBeCloseTo(800_000)
		}
		expect(() => budget.record('researcher:12', 1)).toThrow(RangeError)
		expect(budget.remainingMicroUsd('writer')).toBeCloseTo(1_800_000)
		expect(budget.remainingMicroUsd('lead')).toBeCloseTo(600_000)
	})

	it('reserves writer 15%, lead 5% and researchers 80% so the shares add up to the cap', () => {
		const budget = new RunBudget({ capCents: 400, researchers: 3, hasLead: true })
		const total =
			budget.remainingMicroUsd('writer') +
			budget.remainingMicroUsd('lead') +
			[0, 1, 2].reduce((sum, i) => sum + budget.remainingMicroUsd(`researcher:${i}`), 0)
		expect(total).toBeCloseTo(4_000_000, -1)
	})

	it('rejects a researcher count of zero when re-splitting', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 1, hasLead: true })
		expect(() => budget.assignResearchers(0)).toThrow(RangeError)
	})

	it('reports every spend to the progress callback', () => {
		const seen: number[] = []
		const budget = new RunBudget({
			capCents: 100,
			researchers: 1,
			hasLead: false,
			onSpend: () => seen.push(budget.spentCents),
		})
		budget.recordSearch('researcher:0', 8_000)
		budget.record('writer', 25_000)
		expect(seen).toEqual([1, 3])
	})

	it('says no to a call that would not fit the stage share', () => {
		const budget = new RunBudget({ capCents: 5, researchers: 1, hasLead: false })
		// Researcher share: 85% of 50_000 = 42_500 micro-USD.
		expect(budget.canAfford('researcher:0', 42_500)).toBe(true)
		budget.recordSearch('researcher:0', 8_000)
		expect(budget.canAfford('researcher:0', 34_500)).toBe(true)
		expect(budget.canAfford('researcher:0', 34_501)).toBe(false)
	})

	it('a researcher running dry does not take the writer reserve', () => {
		const budget = new RunBudget({ capCents: 5, researchers: 1, hasLead: false })
		budget.record('researcher:0', 42_500)
		expect(budget.canAfford('researcher:0', 1)).toBe(false)
		expect(budget.canAfford('writer', 7_500)).toBe(true)
	})

	it('flags research as exhausted at 85% of the cap', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 1, hasLead: false })
		budget.record('researcher:0', 849_999)
		expect(budget.researchExhausted).toBe(false)
		budget.record('researcher:0', 1)
		expect(budget.researchExhausted).toBe(true)
	})

	it('reports per-stage cost in cents', () => {
		const budget = new RunBudget({ capCents: 100, researchers: 1, hasLead: false })
		budget.recordSearch('researcher:0', 8_000)
		budget.record('writer', 25_000)
		expect(budget.stageCostCents()).toEqual({ 'researcher:0': 1, writer: 3 })
	})

	it('rejects a bad cap, researcher count, stage or cost', () => {
		expect(() => new RunBudget({ capCents: 0, researchers: 1, hasLead: false })).toThrow(RangeError)
		expect(() => new RunBudget({ capCents: 5, researchers: 0, hasLead: false })).toThrow(RangeError)
		const budget = new RunBudget({ capCents: 5, researchers: 1, hasLead: false })
		expect(() => budget.record('lead', 1)).toThrow(RangeError)
		expect(() => budget.record('writer', -1)).toThrow(RangeError)
		expect(() => budget.record('writer', Number.NaN)).toThrow(RangeError)
	})
})
