import { buildFallbackHeadline } from '../../services/dashboard-headline'

const baseAggregate = {
	workspaceName: 'My Workspace',
	settings: null,
	runningSessions: 0,
	pendingNotifications: 0,
	eventsLast24h: 0,
	uniqueAgentsLast24h: 0,
}

describe('buildFallbackHeadline', () => {
	it('returns the at-rest sentence when nothing is happening', () => {
		expect(buildFallbackHeadline(baseAggregate)).toBe(
			'The team is at rest — no agents are working and nothing needs your call.',
		)
	})

	it('reports a single live session in singular form', () => {
		expect(buildFallbackHeadline({ ...baseAggregate, runningSessions: 1 })).toBe(
			'1 agent is shipping work — nothing needs your call right now.',
		)
	})

	it('pluralizes multiple live sessions', () => {
		expect(buildFallbackHeadline({ ...baseAggregate, runningSessions: 3 })).toBe(
			'3 agents are shipping work — nothing needs your call right now.',
		)
	})

	it('prioritizes pending decisions over live sessions', () => {
		expect(
			buildFallbackHeadline({
				...baseAggregate,
				runningSessions: 2,
				pendingNotifications: 1,
			}),
		).toBe('2 agents are working; 1 decision is waiting on you.')
	})

	it('summarizes a pending decision when no agents are working', () => {
		expect(buildFallbackHeadline({ ...baseAggregate, pendingNotifications: 4 })).toBe(
			'4 decisions are waiting on you.',
		)
	})

	it('falls through to recent activity when sessions and decisions are empty', () => {
		expect(
			buildFallbackHeadline({
				...baseAggregate,
				eventsLast24h: 12,
				uniqueAgentsLast24h: 2,
			}),
		).toBe('2 agents moved things forward today; the team is at rest now.')
	})

	it('is deterministic — identical inputs produce identical outputs', () => {
		const input = { ...baseAggregate, runningSessions: 2, pendingNotifications: 1 }
		expect(buildFallbackHeadline(input)).toBe(buildFallbackHeadline(input))
	})

	it('always produces output within the 140-char limit', () => {
		const cases = [
			baseAggregate,
			{ ...baseAggregate, runningSessions: 99 },
			{ ...baseAggregate, pendingNotifications: 99 },
			{ ...baseAggregate, runningSessions: 99, pendingNotifications: 99 },
			{ ...baseAggregate, eventsLast24h: 99, uniqueAgentsLast24h: 99 },
		]
		for (const c of cases) {
			expect(buildFallbackHeadline(c).length).toBeLessThanOrEqual(140)
		}
	})
})
