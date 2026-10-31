import { describe, expect, it } from 'vitest'
import {
	type EvalQuestion,
	assignBlindIds,
	buildCsv,
	checkMix,
	failedRun,
	normalizeRun,
	parseQuestions,
} from '../../../scripts/research-eval-lib'

const q = (effort: EvalQuestion['effort'] = 'simple'): EvalQuestion => ({
	question: 'What changed in the Danish bookkeeping act?',
	effort,
	original_session_id: 'sess-1',
})

describe('parseQuestions', () => {
	it('accepts a valid list', () => {
		expect(parseQuestions([q()])).toHaveLength(1)
	})

	it('rejects an empty list, a bad effort and a missing session id', () => {
		expect(() => parseQuestions([])).toThrow('non-empty')
		expect(() => parseQuestions([{ ...q(), effort: 'huge' }])).toThrow('effort')
		expect(() => parseQuestions([{ ...q(), original_session_id: '' }])).toThrow(
			'original_session_id',
		)
	})
})

describe('checkMix', () => {
	it('passes 3 simple, 4 comparison, 3 broad', () => {
		const set = [
			...Array(3).fill(q('simple')),
			...Array(4).fill(q('comparison')),
			...Array(3).fill(q('broad')),
		]
		expect(checkMix(set)).toEqual([])
	})

	it('names what is off', () => {
		expect(checkMix([q('simple')]).length).toBeGreaterThan(0)
	})
})

describe('normalizeRun', () => {
	it('reads usage from a nested usage object and flags a run over cap by more than 5%', () => {
		const run = normalizeRun(
			q('comparison'),
			2,
			'r-1',
			{
				status: 'capped',
				cap_cents: 400,
				usage: { cost_cents: 421, tokens_in: 10, tokens_out: 5, searches: 7, extracts: 3 },
				brief: { subtopics: [{}, {}, {}] },
				sources: [{ tier: 1 }, { tier: 2 }, { tier: 3 }, { tier: 1 }],
				warnings: ['thin: pricing'],
				started_at: '2026-11-02T10:00:00Z',
				finished_at: '2026-11-02T10:04:30Z',
				report_md: '# Report',
			},
			999,
		)
		expect(run.capped).toBe(true)
		expect(run.over_cap_5pct).toBe(true)
		expect(run.cost_cents).toBe(421)
		expect(run.researchers).toBe(3)
		expect(run.tier12_share).toBe(0.75)
		expect(run.wall_clock_s).toBe(270)
	})

	it('does not flag a run exactly 5% over, and falls back to the local clock', () => {
		const run = normalizeRun(q(), 1, 'r-2', { status: 'done', cap_cents: 100, cost_cents: 105 }, 42)
		expect(run.over_cap_5pct).toBe(false)
		expect(run.wall_clock_s).toBe(42)
		expect(run.researchers).toBe(1)
		expect(run.tier12_share).toBeNull()
	})

	it('prefers the route tier12_share over counting sources', () => {
		const run = normalizeRun(
			q(),
			1,
			'r-3',
			{ status: 'done', tier12_share: 0.9, sources: [{ tier: 3 }] },
			1,
		)
		expect(run.tier12_share).toBe(0.9)
	})
})

describe('buildCsv', () => {
	it('writes one row per run, converts cents to dollars and quotes awkward cells', () => {
		const ok = normalizeRun(
			q(),
			1,
			'r-1',
			{
				status: 'done',
				cap_cents: 100,
				cost_cents: 62,
				warnings: ['a, b', 'c'],
			},
			10,
		)
		const bad = failedRun(q('broad'), 2, '', 'error', 'POST 500: "boom"', 3)
		const lines = buildCsv([ok, bad], new Map([[1, 'R02']]))
			.trimEnd()
			.split('\n')
		expect(lines).toHaveLength(3)
		expect(lines[1]).toContain('R02')
		expect(lines[1]).toContain('0.62')
		expect(lines[1]).toContain('"a, b | c"')
		expect(lines[2]).toContain('"POST 500: ""boom"""')
	})
})

describe('assignBlindIds', () => {
	const items = [
		{ arm: 'tool' as const, index: 1 },
		{ arm: 'baseline' as const, index: 1 },
		{ arm: 'tool' as const, index: 2 },
		{ arm: 'baseline' as const, index: 2 },
	]

	it('gives every report a unique neutral id', () => {
		const ids = assignBlindIds(items, 1).map((b) => b.blind_id)
		expect(new Set(ids).size).toBe(4)
		expect(ids.every((id) => /^R\d{2}$/.test(id))).toBe(true)
	})

	it('is reproducible for one seed and changes with another', () => {
		expect(assignBlindIds(items, 7)).toEqual(assignBlindIds(items, 7))
		const orders = [1, 2, 3, 4, 5].map((s) =>
			assignBlindIds(items, s)
				.map((b) => `${b.arm}${b.index}`)
				.join(),
		)
		expect(new Set(orders).size).toBeGreaterThan(1)
	})
})
