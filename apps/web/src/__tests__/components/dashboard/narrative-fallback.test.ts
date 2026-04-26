import { buildFallbackHeadline } from '@/components/dashboard/narrative-fallback'
import { describe, expect, it } from 'vitest'

describe('buildFallbackHeadline', () => {
	it('returns calm idle sentence when nothing is happening', () => {
		const result = buildFallbackHeadline({
			runningSessions: 0,
			pendingNotifications: 0,
			eventsLast24h: 0,
			uniqueAgentsLast24h: 0,
		})
		expect(result).toBe('The team is at rest — no agents are working and nothing needs your call.')
	})

	it('describes recent activity when the team has settled but moved today', () => {
		const result = buildFallbackHeadline({
			runningSessions: 0,
			pendingNotifications: 0,
			eventsLast24h: 12,
			uniqueAgentsLast24h: 3,
		})
		expect(result).toBe('3 agents moved things forward today; the team is at rest now.')
	})

	it('uses singular agent when only one moved things forward', () => {
		const result = buildFallbackHeadline({
			runningSessions: 0,
			pendingNotifications: 0,
			eventsLast24h: 4,
			uniqueAgentsLast24h: 1,
		})
		expect(result).toBe('1 agent moved things forward today; the team is at rest now.')
	})

	it('falls back to a count of 1 when events exist but uniqueAgents is zero', () => {
		const result = buildFallbackHeadline({
			runningSessions: 0,
			pendingNotifications: 0,
			eventsLast24h: 7,
			uniqueAgentsLast24h: 0,
		})
		expect(result).toBe('1 agents moved things forward today; the team is at rest now.')
	})

	it('describes shipping work when sessions are running and no decisions wait', () => {
		const result = buildFallbackHeadline({
			runningSessions: 3,
			pendingNotifications: 0,
			eventsLast24h: 50,
			uniqueAgentsLast24h: 5,
		})
		expect(result).toBe('3 agents are shipping work — nothing needs your call right now.')
	})

	it('uses singular agent form when exactly one session is running', () => {
		const result = buildFallbackHeadline({
			runningSessions: 1,
			pendingNotifications: 0,
			eventsLast24h: 0,
			uniqueAgentsLast24h: 0,
		})
		expect(result).toBe('1 agent is shipping work — nothing needs your call right now.')
	})

	it('prioritises pending decisions over live sessions', () => {
		const result = buildFallbackHeadline({
			runningSessions: 2,
			pendingNotifications: 3,
			eventsLast24h: 10,
			uniqueAgentsLast24h: 2,
		})
		expect(result).toBe('2 agents are working; 3 decisions are waiting on you.')
	})

	it('uses singular wording for one decision and one running agent', () => {
		const result = buildFallbackHeadline({
			runningSessions: 1,
			pendingNotifications: 1,
			eventsLast24h: 0,
			uniqueAgentsLast24h: 0,
		})
		expect(result).toBe('1 agent is working; 1 decision is waiting on you.')
	})

	it('omits the agents clause when only decisions are pending', () => {
		const result = buildFallbackHeadline({
			runningSessions: 0,
			pendingNotifications: 2,
			eventsLast24h: 0,
			uniqueAgentsLast24h: 0,
		})
		expect(result).toBe('2 decisions are waiting on you.')
	})

	it('uses singular wording when exactly one decision is pending and no agents working', () => {
		const result = buildFallbackHeadline({
			runningSessions: 0,
			pendingNotifications: 1,
			eventsLast24h: 0,
			uniqueAgentsLast24h: 0,
		})
		expect(result).toBe('1 decision is waiting on you.')
	})

	it('is deterministic for identical inputs', () => {
		const input = {
			runningSessions: 2,
			pendingNotifications: 1,
			eventsLast24h: 5,
			uniqueAgentsLast24h: 2,
		}
		expect(buildFallbackHeadline(input)).toBe(buildFallbackHeadline(input))
	})

	it('returns sentences within the 140-char limit for representative inputs', () => {
		const inputs = [
			{ runningSessions: 0, pendingNotifications: 0, eventsLast24h: 0, uniqueAgentsLast24h: 0 },
			{ runningSessions: 0, pendingNotifications: 0, eventsLast24h: 99, uniqueAgentsLast24h: 9 },
			{ runningSessions: 9, pendingNotifications: 0, eventsLast24h: 99, uniqueAgentsLast24h: 9 },
			{ runningSessions: 9, pendingNotifications: 9, eventsLast24h: 99, uniqueAgentsLast24h: 9 },
			{ runningSessions: 0, pendingNotifications: 9, eventsLast24h: 99, uniqueAgentsLast24h: 9 },
		]
		for (const input of inputs) {
			expect(buildFallbackHeadline(input).length).toBeLessThanOrEqual(140)
		}
	})
})
