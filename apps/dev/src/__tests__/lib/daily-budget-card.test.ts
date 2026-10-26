import {
	type BudgetTarget,
	type TriggerWindowStats,
	bar,
	buildBudgetCard,
	formatAmount,
	forecastLines,
	projectMonth,
	todayLine,
	yesterdayLine,
} from '../../lib/daily-budget-card'

const tokens: BudgetTarget = { unit: 'tokens', amount: 2_000_000 }
const usd: BudgetTarget = { unit: 'dollars', amount: 10 }

function stats(over: Partial<TriggerWindowStats> & { name: string }): TriggerWindowStats {
	return { triggerId: over.name, runs: 0, knownRuns: 0, spent: 0, ...over }
}

describe('projectMonth', () => {
	it('is average cost per run, times runs per day, times days in the month', () => {
		// 14 runs in 14 days at 100k each: 1 run a day, 100k a day, 3M over 30 days.
		const f = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 1_400_000 })],
			tokens,
			14,
			30,
		)
		expect(f.monthly).toBeCloseTo(3_000_000)
		expect(f.monthTarget).toBe(60_000_000)
		expect(f.warn).toBe(false)
	})

	it('averages over the runs that have a cost but counts every run for frequency', () => {
		// 28 runs, only 14 with a cost (100k each): 2 runs a day at 100k.
		const f = projectMonth(
			[stats({ name: 'A', runs: 28, knownRuns: 14, spent: 1_400_000 })],
			tokens,
			14,
			30,
		)
		expect(f.monthly).toBeCloseTo(6_000_000)
	})

	it('warns at 80% of the month target and not below', () => {
		const at = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 14 * 80 })],
			usd,
			14,
			10,
		)
		// 80 a day against 10 a day is far over; use a precise boundary instead.
		expect(at.warn).toBe(true)
		const exact = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 14 * 8 })],
			usd,
			14,
			30,
		)
		expect(exact.share).toBeCloseTo(0.8)
		expect(exact.warn).toBe(true)
		const below = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 14 * 7.9 })],
			usd,
			14,
			30,
		)
		expect(below.warn).toBe(false)
	})

	it('names the five heaviest, highest first, and puts unknown cost last, never as zero', () => {
		const list = [
			stats({ name: 'a', runs: 14, knownRuns: 14, spent: 14 }),
			stats({ name: 'b', runs: 14, knownRuns: 14, spent: 70 }),
			stats({ name: 'c', runs: 14, knownRuns: 14, spent: 42 }),
			stats({ name: 'd', runs: 14, knownRuns: 14, spent: 28 }),
			stats({ name: 'e', runs: 14, knownRuns: 14, spent: 56 }),
			stats({ name: 'f', runs: 14, knownRuns: 14, spent: 7 }),
			stats({ name: 'unknown', runs: 40, knownRuns: 0, spent: 0 }),
		]
		const f = projectMonth(list, usd, 14, 30)
		expect(f.heaviest.map((p) => p.name)).toEqual(['b', 'e', 'c', 'd', 'a'])
		expect(f.unknownTriggers).toBe(1)
		const onlyUnknown = projectMonth([list[6] as TriggerWindowStats], usd, 14, 30)
		expect(onlyUnknown.heaviest).toEqual([{ name: 'unknown', monthly: null }])
	})
})

describe('formatting', () => {
	it('formats tokens and dollars', () => {
		expect(formatAmount(1_800_000, 'tokens')).toBe('1.8M tokens')
		expect(formatAmount(12_400, 'tokens')).toBe('12k tokens')
		expect(formatAmount(3.2, 'dollars')).toBe('$3.20')
	})

	it('draws a bar that is empty at zero, shows something once spent and caps at full', () => {
		expect(bar(0)).toBe('░░░░░░░░░░')
		expect(bar(0.01)).toBe('█░░░░░░░░░')
		expect(bar(0.5)).toBe('█████░░░░░')
		expect(bar(3)).toBe('██████████')
	})
})

describe('card lines', () => {
	it('yesterday: nothing ran, cost known, partly unknown, all unknown', () => {
		expect(yesterdayLine({ runs: 0, knownRuns: 0, spent: 0 }, 'dollars')).toBe(
			'Yesterday: nothing ran.',
		)
		expect(yesterdayLine({ runs: 38, knownRuns: 38, spent: 3.2 }, 'dollars')).toBe(
			'Yesterday: 38 runs, $3.20.',
		)
		expect(yesterdayLine({ runs: 10, knownRuns: 7, spent: 1 }, 'dollars')).toBe(
			'Yesterday: 10 runs, $1.00 (cost unknown for 3).',
		)
		expect(yesterdayLine({ runs: 1, knownRuns: 0, spent: 0 }, 'dollars')).toBe(
			'Yesterday: 1 run. Estimate unknown.',
		)
	})

	it("today's bar is against the target", () => {
		expect(todayLine({ runs: 0, knownRuns: 0, spent: 0 }, tokens)).toBe(
			'Today: ░░░░░░░░░░ 0 tokens of 2.0M tokens so far.',
		)
		expect(todayLine({ runs: 3, knownRuns: 3, spent: 1_000_000 }, tokens)).toBe(
			'Today: █████░░░░░ 1.0M tokens of 2.0M tokens so far.',
		)
	})

	it('builds the whole card and marks an approximate forecast', () => {
		const forecast = projectMonth(
			[stats({ name: 'Nightly drafts', runs: 14, knownRuns: 14, spent: 14 * 80 })],
			usd,
			14,
			30,
		)
		const card = buildBudgetCard({
			target: usd,
			yesterday: { runs: 4, knownRuns: 4, spent: 9.5 },
			today: { runs: 0, knownRuns: 0, spent: 0 },
			forecast,
			approximate: true,
		})
		expect(card.headline).toBe('Yesterday: 4 runs, $9.50.')
		expect(card.rationale).toContain('Month forecast (approximate): $2400.00 of $300.00 (800%).')
		expect(card.rationale).toContain('Over the month target at this pace.')
		expect(card.rationale).toContain('Heaviest triggers:\n- Nightly drafts: $2400.00')
	})

	it('says which triggers are left out of the total, in the right grammar', () => {
		const one = projectMonth(
			[stats({ name: 'a', runs: 14, knownRuns: 14, spent: 14 }), stats({ name: 'u', runs: 2 })],
			usd,
			14,
			30,
		)
		const two = projectMonth(
			[
				stats({ name: 'a', runs: 14, knownRuns: 14, spent: 14 }),
				stats({ name: 'u', runs: 2 }),
				stats({ name: 'v', runs: 2 }),
			],
			usd,
			14,
			30,
		)
		expect(forecastLines(one, usd, false).join('\n')).toContain(
			'1 trigger has no recorded cost, so it is left out of the total.',
		)
		expect(forecastLines(two, usd, false).join('\n')).toContain(
			'2 triggers have no recorded cost, so they are left out of the total.',
		)
	})

	it('says Estimate unknown when no trigger has a recorded cost', () => {
		const forecast = projectMonth([stats({ name: 'x', runs: 5, knownRuns: 0 })], usd, 14, 30)
		const card = buildBudgetCard({
			target: usd,
			yesterday: { runs: 5, knownRuns: 0, spent: 0 },
			today: { runs: 0, knownRuns: 0, spent: 0 },
			forecast,
			approximate: false,
		})
		expect(card.rationale).toContain('Month forecast: Estimate unknown')
		expect(card.rationale).not.toContain('$0.00 of')
	})
})
