import { describe, expect, it } from 'vitest'
import { evaluateFilterV2 } from '../../services/trigger-runner'

/**
 * Contract table for matcher v2 (tech spec §2.1). Locks in the four axes the
 * bet #8 fix depends on:
 *  - array value  → any-of semantics (the change fixing the 13 dead triggers)
 *  - scalar value → strict equality (backwards compat with today's matcher)
 *  - empty array  → matches nothing (edge case explicitly named in the task)
 *  - nested path  → resolves through `resolvePath()` unchanged
 *
 * `missShape` is asserted on every miss so the `trigger_match_failed` label
 * cannot silently drift from the four values the observability spec calls out.
 */
describe('evaluateFilterV2', () => {
	describe('array-valued filters (matcher v2 core change)', () => {
		it.each([
			{
				name: 'first-element hit',
				filter: { status: ['onboarding', 'kickoff'] },
				root: { status: 'onboarding' },
			},
			{
				name: 'later-element hit',
				filter: { status: ['onboarding', 'kickoff'] },
				root: { status: 'kickoff' },
			},
			{
				name: 'numeric any-of',
				filter: { attention: [3, 4, 5] },
				root: { attention: 4 },
			},
			{
				name: 'single-element array',
				filter: { status: ['live'] },
				root: { status: 'live' },
			},
		])('matches when actual is any array element ($name)', ({ filter, root }) => {
			expect(evaluateFilterV2(filter, root)).toEqual({ matches: true })
		})

		it('reports array_value_mismatch when actual resolves but is not in the array', () => {
			const result = evaluateFilterV2({ status: ['onboarding', 'kickoff'] }, { status: 'archived' })
			expect(result).toEqual({
				matches: false,
				missShape: 'array_value_mismatch',
				failedKey: 'status',
			})
		})

		it('reports path_missing (not array_value_mismatch) when actual is undefined', () => {
			// Distinct label so ops can tell a hydration slip apart from a genuine
			// value mismatch — same root cause on the dashboard would obscure both.
			const result = evaluateFilterV2({ status: ['onboarding'] }, { other_key: 'onboarding' })
			expect(result).toEqual({
				matches: false,
				missShape: 'path_missing',
				failedKey: 'status',
			})
		})
	})

	describe('empty-array filters', () => {
		it('matches nothing and reports array_empty', () => {
			expect(evaluateFilterV2({ status: [] }, { status: 'onboarding' })).toEqual({
				matches: false,
				missShape: 'array_empty',
				failedKey: 'status',
			})
		})

		it('reports array_empty even when the path is missing', () => {
			// array_empty takes precedence over path_missing — an empty allow-list
			// is a config error, and surfacing it as "path missing" would send ops
			// looking for a hydration bug that does not exist.
			expect(evaluateFilterV2({ status: [] }, {})).toEqual({
				matches: false,
				missShape: 'array_empty',
				failedKey: 'status',
			})
		})
	})

	describe('scalar filters (backwards compat)', () => {
		it.each([
			{ name: 'string equality', filter: { status: 'onboarding' }, root: { status: 'onboarding' } },
			{ name: 'number equality', filter: { attention: 4 }, root: { attention: 4 } },
			{ name: 'boolean equality', filter: { enabled: true }, root: { enabled: true } },
		])('matches on strict equality ($name)', ({ filter, root }) => {
			expect(evaluateFilterV2(filter, root)).toEqual({ matches: true })
		})

		it('reports scalar_mismatch when actual resolves to a different scalar', () => {
			const result = evaluateFilterV2({ status: 'onboarding' }, { status: 'archived' })
			expect(result).toEqual({
				matches: false,
				missShape: 'scalar_mismatch',
				failedKey: 'status',
			})
		})

		it('reports path_missing when actual is undefined on a scalar filter', () => {
			expect(evaluateFilterV2({ status: 'onboarding' }, { other_key: 'onboarding' })).toEqual({
				matches: false,
				missShape: 'path_missing',
				failedKey: 'status',
			})
		})

		it('does not coerce number → string (strict equality)', () => {
			// `resolveConditionField` in conditions[] uses loose `==` — the filter
			// map deliberately does NOT, so a numeric filter cannot match a
			// stringified event field. Confirming today's v1 behaviour is
			// preserved by v2 on the scalar branch.
			const result = evaluateFilterV2({ attention: 4 }, { attention: '4' })
			expect(result).toEqual({
				matches: false,
				missShape: 'scalar_mismatch',
				failedKey: 'attention',
			})
		})
	})

	describe('nested dotted paths (resolvePath unchanged)', () => {
		it('resolves scalar nested paths', () => {
			expect(
				evaluateFilterV2({ 'data.status': 'onboarding' }, { data: { status: 'onboarding' } }),
			).toEqual({ matches: true })
		})

		it('resolves array-valued filters at nested paths', () => {
			expect(
				evaluateFilterV2(
					{ 'data.status': ['onboarding', 'kickoff'] },
					{ data: { status: 'kickoff' } },
				),
			).toEqual({ matches: true })
		})

		it('reports path_missing when a nested step is absent', () => {
			expect(evaluateFilterV2({ 'data.status': ['onboarding'] }, { data: {} })).toEqual({
				matches: false,
				missShape: 'path_missing',
				failedKey: 'data.status',
			})
		})
	})

	describe('multi-key filters (every entry must match)', () => {
		it('matches when every entry passes', () => {
			expect(
				evaluateFilterV2(
					{ status: ['onboarding', 'kickoff'], attention: 4 },
					{ status: 'kickoff', attention: 4 },
				),
			).toEqual({ matches: true })
		})

		it('reports the FIRST failing key (short-circuits)', () => {
			const result = evaluateFilterV2(
				{ status: ['onboarding'], attention: 4 },
				{ status: 'archived', attention: 999 },
			)
			expect(result).toEqual({
				matches: false,
				missShape: 'array_value_mismatch',
				failedKey: 'status',
			})
		})
	})

	describe('empty filter map', () => {
		it('matches every event (no entries to disqualify it)', () => {
			expect(evaluateFilterV2({}, { anything: 'anywhere' })).toEqual({ matches: true })
		})
	})
})
