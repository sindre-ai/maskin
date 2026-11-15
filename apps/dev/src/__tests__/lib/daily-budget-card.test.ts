import {
	type BudgetTarget,
	type TriggerWindowStats,
	bar,
	buildBudgetCard,
	forecastLines,
	formatPercent,
	projectMonth,
	readBudgetSettings,
	todayLine,
	yesterdayLine,
} from '../../lib/daily-budget-card'

/** Percent of the plan per day. */
const pct: BudgetTarget = { amount: 10 }
const small: BudgetTarget = { amount: 1 }

function stats(over: Partial<TriggerWindowStats> & { name: string }): TriggerWindowStats {
	return { triggerId: over.name, runs: 0, knownRuns: 0, spent: 0, ...over }
}

describe('projectMonth', () => {
	it('is average cost per run, times runs per day, times days in the month', () => {
		// 14 runs in 14 days at 2% each: 1 run a day, 2% a day, 60% over 30 days.
		const f = projectMonth([stats({ name: 'A', runs: 14, knownRuns: 14, spent: 28 })], pct, 14, 30)
		expect(f.monthly).toBeCloseTo(60)
		expect(f.monthTarget).toBe(300)
		expect(f.warn).toBe(false)
	})

	it('averages over the runs that have a cost but counts every run for frequency', () => {
		// 28 runs, only 14 with a cost (2% each): 2 runs a day at 2%.
		const f = projectMonth([stats({ name: 'A', runs: 28, knownRuns: 14, spent: 28 })], pct, 14, 30)
		expect(f.monthly).toBeCloseTo(120)
	})

	it('warns at 80% of the month target and not below', () => {
		const at = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 14 * 80 })],
			pct,
			14,
			10,
		)
		// 80% a day against 10% a day is far over; use a precise boundary instead.
		expect(at.warn).toBe(true)
		const exact = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 14 * 8 })],
			pct,
			14,
			30,
		)
		expect(exact.share).toBeCloseTo(0.8)
		expect(exact.warn).toBe(true)
		const below = projectMonth(
			[stats({ name: 'A', runs: 14, knownRuns: 14, spent: 14 * 7.9 })],
			pct,
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
		const f = projectMonth(list, pct, 14, 30)
		expect(f.heaviest.map((p) => p.name)).toEqual(['b', 'e', 'c', 'd', 'a'])
		expect(f.unknownTriggers).toBe(1)
		const onlyUnknown = projectMonth([list[6] as TriggerWindowStats], pct, 14, 30)
		expect(onlyUnknown.heaviest).toEqual([{ name: 'unknown', monthly: null }])
	})
})

describe('formatting', () => {
	it('formats a percent with one decimal at most, and never shows a small share as 0', () => {
		expect(formatPercent(3.3)).toBe('3.3%')
		expect(formatPercent(12)).toBe('12%')
		expect(formatPercent(12.04)).toBe('12%')
		expect(formatPercent(0.04)).toBe('<0.1%')
		expect(formatPercent(0)).toBe('0%')
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
		expect(yesterdayLine({ runs: 0, knownRuns: 0, spent: 0 })).toBe('Yesterday: nothing ran.')
		expect(yesterdayLine({ runs: 38, knownRuns: 38, spent: 3.2 })).toBe(
			'Yesterday: 38 runs, 3.2% of plan.',
		)
		expect(yesterdayLine({ runs: 10, knownRuns: 7, spent: 1 })).toBe(
			'Yesterday: 10 runs, 1% of plan (cost unknown for 3).',
		)
		expect(yesterdayLine({ runs: 1, knownRuns: 0, spent: 0 })).toBe(
			'Yesterday: 1 run. Estimate unknown.',
		)
	})

	it("today's bar is against the target", () => {
		expect(todayLine({ runs: 0, knownRuns: 0, spent: 0 }, pct)).toBe(
			'Today: ░░░░░░░░░░ 0% of 10% so far.',
		)
		expect(todayLine({ runs: 3, knownRuns: 3, spent: 5 }, pct)).toBe(
			'Today: █████░░░░░ 5% of 10% so far.',
		)
	})

	it('builds the whole card in percent only and marks an approximate forecast', () => {
		const forecast = projectMonth(
			[stats({ name: 'Nightly drafts', runs: 14, knownRuns: 14, spent: 28 })],
			small,
			14,
			30,
		)
		const card = buildBudgetCard({
			target: small,
			yesterday: { runs: 4, knownRuns: 4, spent: 2.5 },
			today: { runs: 0, knownRuns: 0, spent: 0 },
			forecast,
			approximate: true,
		})
		expect(card.headline).toBe('Yesterday: 4 runs, 2.5% of plan.')
		expect(card.rationale).toContain(
			'Month forecast (approximate): 60% of plan. Your daily target adds up to 30% over the month.',
		)
		expect(card.rationale).toContain('Over the month target at this pace.')
		expect(card.rationale).toContain('Heaviest triggers:\n- Nightly drafts: 60%')
		expect(`${card.headline}\n${card.rationale}`).not.toMatch(/token|\$|dollar/i)
	})

	it('adds the note about an earlier target at the end', () => {
		const card = buildBudgetCard({
			target: pct,
			yesterday: { runs: 0, knownRuns: 0, spent: 0 },
			today: { runs: 0, knownRuns: 0, spent: 0 },
			forecast: projectMonth([], pct, 14, 30),
			approximate: false,
			note: 'A note.',
		})
		expect(card.rationale.endsWith('A note.')).toBe(true)
	})

	it('says which triggers are left out of the total, in the right grammar', () => {
		const one = projectMonth(
			[stats({ name: 'a', runs: 14, knownRuns: 14, spent: 14 }), stats({ name: 'u', runs: 2 })],
			pct,
			14,
			30,
		)
		const two = projectMonth(
			[
				stats({ name: 'a', runs: 14, knownRuns: 14, spent: 14 }),
				stats({ name: 'u', runs: 2 }),
				stats({ name: 'v', runs: 2 }),
			],
			pct,
			14,
			30,
		)
		expect(forecastLines(one, false).join('\n')).toContain(
			'1 trigger has no recorded cost, so it is left out of the total.',
		)
		expect(forecastLines(two, false).join('\n')).toContain(
			'2 triggers have no recorded cost, so they are left out of the total.',
		)
	})

	it('says Estimate unknown when no trigger has a recorded cost', () => {
		const forecast = projectMonth([stats({ name: 'x', runs: 5, knownRuns: 0 })], pct, 14, 30)
		const card = buildBudgetCard({
			target: pct,
			yesterday: { runs: 5, knownRuns: 0, spent: 0 },
			today: { runs: 0, knownRuns: 0, spent: 0 },
			forecast,
			approximate: false,
		})
		expect(card.rationale).toContain('Month forecast: Estimate unknown')
		expect(card.rationale).not.toContain('Month forecast: 0%')
	})
})

describe('readBudgetSettings', () => {
	const at = (daily_budget: unknown) => ({ daily_budget })

	it('is off without a target, and for one that does not parse', () => {
		expect(readBudgetSettings({}, 2000)).toBeNull()
		expect(readBudgetSettings(at({ unit: 'kroner', amount: 5 }), 2000)).toBeNull()
	})

	it('reads a percent target as it is', () => {
		expect(
			readBudgetSettings(at({ unit: 'percent', amount: 4, timezone: 'Europe/Oslo' }), 2000),
		).toEqual({
			target: { amount: 4 },
			timezone: 'Europe/Oslo',
			note: null,
		})
	})

	it('converts an earlier dollar target to its share of the plan limit', () => {
		// $0.80 a day of a $20 plan (2000 cents) is 4%.
		const cfg = readBudgetSettings(at({ unit: 'dollars', amount: 0.8 }), 2000)
		expect(cfg?.target).toEqual({ amount: 4 })
		expect(cfg?.note).toBeNull()
	})

	it('uses the default and says so for an earlier token target', () => {
		const cfg = readBudgetSettings(at({ unit: 'tokens', amount: 2_000_000 }), 2000)
		expect(cfg?.target).toEqual({ amount: 3.3 })
		expect(cfg?.note).toContain('earlier daily target could not be turned into a percent')
	})
})
