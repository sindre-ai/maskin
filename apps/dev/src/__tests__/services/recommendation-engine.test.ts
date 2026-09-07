import { describe, expect, it } from 'vitest'
import {
	type Predicate,
	type RecommendationBundle,
	type WorkspaceState,
	evaluatePredicate,
	evaluateRecommendation,
	renderWhyLine,
} from '../../services/marketplace-recommendation'

// A representative workspace: has Slack + GitHub connected, one loop
// (customer-conversations) installed, one agent (research), two humans.
function baseState(): WorkspaceState {
	return {
		integrations: new Set(['slack', 'github']),
		installedLoops: new Map([
			['customer-conversations', { slug: 'customer-conversations', display_name: 'Customer Conversations' }],
		]),
		installedAgents: new Map([
			['research', { slug: 'research', display_name: 'Research' }],
		]),
		installedSkills: new Map(),
		humanCount: 2,
	}
}

describe('evaluatePredicate — predicate vocabulary (spec §4.1)', () => {
	it('workspace_has_integration matches when any listed slug is connected', () => {
		const state = baseState()
		expect(evaluatePredicate({ workspace_has_integration: ['slack'] } as Predicate, state)).toEqual({
			matched_integration: 'slack',
		})
		expect(
			evaluatePredicate({ workspace_has_integration: ['zendesk', 'slack'] } as Predicate, state),
		).toEqual({ matched_integration: 'slack' })
		expect(evaluatePredicate({ workspace_has_integration: ['zendesk'] } as Predicate, state)).toBeNull()
	})

	it('workspace_missing_integration matches when NONE of the listed slugs are connected', () => {
		const state = baseState()
		expect(
			evaluatePredicate({ workspace_missing_integration: ['zendesk'] } as Predicate, state),
		).toEqual({})
		expect(
			evaluatePredicate({ workspace_missing_integration: ['slack'] } as Predicate, state),
		).toBeNull()
		expect(
			evaluatePredicate(
				{ workspace_missing_integration: ['zendesk', 'linear'] } as Predicate,
				state,
			),
		).toEqual({})
	})

	it('workspace_has_loop returns the matched loop as ctx for placeholder resolution', () => {
		const state = baseState()
		expect(
			evaluatePredicate({ workspace_has_loop: ['customer-conversations'] } as Predicate, state),
		).toEqual({
			matched_loop: { slug: 'customer-conversations', display_name: 'Customer Conversations' },
		})
		expect(evaluatePredicate({ workspace_has_loop: ['sales-triage'] } as Predicate, state)).toBeNull()
	})

	it('workspace_missing_loop matches when NONE of the listed slugs are installed', () => {
		const state = baseState()
		expect(
			evaluatePredicate({ workspace_missing_loop: ['sales-triage'] } as Predicate, state),
		).toEqual({})
		expect(
			evaluatePredicate({ workspace_missing_loop: ['customer-conversations'] } as Predicate, state),
		).toBeNull()
	})

	it('workspace_has_agent + workspace_missing_agent behave analogously', () => {
		const state = baseState()
		expect(evaluatePredicate({ workspace_has_agent: ['research'] } as Predicate, state)).toEqual({
			matched_agent: { slug: 'research', display_name: 'Research' },
		})
		expect(evaluatePredicate({ workspace_missing_agent: ['coach'] } as Predicate, state)).toEqual({})
		expect(evaluatePredicate({ workspace_missing_agent: ['research'] } as Predicate, state)).toBeNull()
	})

	it('workspace_size_gte matches on human count', () => {
		const state = baseState()
		expect(evaluatePredicate({ workspace_size_gte: 2 } as Predicate, state)).toEqual({})
		expect(evaluatePredicate({ workspace_size_gte: 3 } as Predicate, state)).toBeNull()
		expect(evaluatePredicate({ workspace_size_gte: 0 } as Predicate, state)).toEqual({})
	})
})

describe('evaluatePredicate — and/or/not composition (spec §4.1)', () => {
	const state = baseState()

	it('and merges match contexts; short-circuits on first mismatch', () => {
		const both: Predicate = {
			and: [
				{ workspace_has_integration: ['slack'] },
				{ workspace_has_loop: ['customer-conversations'] },
			],
		}
		expect(evaluatePredicate(both, state)).toEqual({
			matched_integration: 'slack',
			matched_loop: { slug: 'customer-conversations', display_name: 'Customer Conversations' },
		})

		const oneFails: Predicate = {
			and: [
				{ workspace_has_integration: ['slack'] },
				{ workspace_has_loop: ['sales-triage'] },
			],
		}
		expect(evaluatePredicate(oneFails, state)).toBeNull()
	})

	it('or returns the first matching child ctx', () => {
		const either: Predicate = {
			or: [{ workspace_has_integration: ['zendesk'] }, { workspace_has_integration: ['slack'] }],
		}
		expect(evaluatePredicate(either, state)).toEqual({ matched_integration: 'slack' })

		const noneMatch: Predicate = {
			or: [
				{ workspace_has_integration: ['zendesk'] },
				{ workspace_has_loop: ['sales-triage'] },
			],
		}
		expect(evaluatePredicate(noneMatch, state)).toBeNull()
	})

	it('not inverts, returning empty ctx on inner mismatch', () => {
		expect(
			evaluatePredicate({ not: { workspace_has_integration: ['zendesk'] } } as Predicate, state),
		).toEqual({})
		expect(
			evaluatePredicate({ not: { workspace_has_integration: ['slack'] } } as Predicate, state),
		).toBeNull()
	})
})

describe('evaluateRecommendation — first matching rule wins (spec §4.1)', () => {
	it('returns matched=false when bundle is null / empty / has no rules', () => {
		const state = baseState()
		expect(evaluateRecommendation(null, state)).toEqual({ matched: false, score_boost: 0 })
		expect(evaluateRecommendation(undefined, state)).toEqual({ matched: false, score_boost: 0 })
		expect(evaluateRecommendation({}, state)).toEqual({ matched: false, score_boost: 0 })
		expect(evaluateRecommendation({ rules: [] }, state)).toEqual({ matched: false, score_boost: 0 })
	})

	it('picks the FIRST matching rule and renders its WHY line with score_boost applied', () => {
		const state = baseState()
		const bundle: RecommendationBundle = {
			score_boost: 10,
			rules: [
				{ when: { workspace_has_integration: ['zendesk'] }, why: 'zendesk-based first choice' },
				{ when: { workspace_has_integration: ['slack'] }, why: 'slack-based second choice' },
				{ when: { workspace_size_gte: 1 }, why: 'never reached' },
			],
		}
		expect(evaluateRecommendation(bundle, state)).toEqual({
			matched: true,
			why_line: 'slack-based second choice',
			score_boost: 10,
		})
	})

	it('returns matched=false when no rule matches', () => {
		const state = baseState()
		const bundle: RecommendationBundle = {
			score_boost: 5,
			rules: [
				{ when: { workspace_has_integration: ['zendesk'] }, why: 'no' },
				{ when: { workspace_has_loop: ['sales-triage'] }, why: 'no either' },
			],
		}
		expect(evaluateRecommendation(bundle, state)).toEqual({ matched: false, score_boost: 0 })
	})
})

describe('renderWhyLine — placeholder resolution (spec §4.2)', () => {
	it('substitutes {matched_loop.display_name} from an and-composed ctx', () => {
		const state = baseState()
		const bundle: RecommendationBundle = {
			rules: [
				{
					when: {
						and: [
							{ workspace_has_loop: ['customer-conversations'] },
							{ workspace_missing_loop: ['customer-feedback-resolution'] },
						],
					},
					why: 'your {matched_loop.display_name} loop reads conversations but not calls — this closes the gap',
				},
			],
		}
		const result = evaluateRecommendation(bundle, state)
		expect(result.matched).toBe(true)
		expect(result.why_line).toBe(
			'your Customer Conversations loop reads conversations but not calls — this closes the gap',
		)
	})

	it('substitutes a bare {matched_integration} scalar', () => {
		expect(renderWhyLine('you use {matched_integration} for chat', { matched_integration: 'slack' })).toBe(
			'you use slack for chat',
		)
	})

	it('leaves an unresolvable placeholder as-is so authors catch it in preview', () => {
		expect(renderWhyLine('for {matched_loop.display_name}', {})).toBe('for {matched_loop.display_name}')
		expect(renderWhyLine('for {matched_loop.no_such_field}', {
			matched_loop: { slug: 's', display_name: 'D' },
		})).toBe('for {matched_loop.no_such_field}')
	})

	it('substitutes multiple placeholders in one template', () => {
		expect(
			renderWhyLine('{matched_integration} + {matched_loop.display_name}', {
				matched_integration: 'slack',
				matched_loop: { slug: 'cc', display_name: 'CC' },
			}),
		).toBe('slack + CC')
	})
})

describe('performance budget (spec §4.3)', () => {
	it('evaluates a ~200-row catalog against a 4-rule bundle in under 50ms', () => {
		const state = baseState()
		const bundle: RecommendationBundle = {
			score_boost: 5,
			rules: [
				{ when: { workspace_has_integration: ['slack'] }, why: 'you use {matched_integration}' },
				{ when: { workspace_has_loop: ['customer-conversations'] }, why: 'have {matched_loop.display_name}' },
				{ when: { workspace_missing_agent: ['coach'] }, why: 'coach agent would help here' },
				{
					when: {
						and: [
							{ workspace_size_gte: 2 },
							{ or: [{ workspace_has_integration: ['github'] }, { workspace_has_integration: ['linear'] }] },
						],
					},
					why: 'team of {matched_integration}',
				},
			],
		}
		const t0 = performance.now()
		for (let i = 0; i < 200; i++) evaluateRecommendation(bundle, state)
		const elapsed = performance.now() - t0
		expect(elapsed).toBeLessThan(50)
	})
})
