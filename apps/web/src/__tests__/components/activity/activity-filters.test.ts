import { matchesFilter } from '@/components/activity/activity-filters'
import { buildActorListItem, buildEventResponse } from '../../factories'

describe('matchesFilter', () => {
	const actorsById = new Map([
		['agent-1', buildActorListItem({ id: 'agent-1', type: 'agent' })],
		['human-1', buildActorListItem({ id: 'human-1', type: 'human' })],
	])

	describe('decision filter', () => {
		it('matches bet entity type', () => {
			const event = buildEventResponse({ entityType: 'bet' })
			expect(matchesFilter(event, 'decision', actorsById)).toBe(true)
		})

		it('matches notification with needs_input type', () => {
			const event = buildEventResponse({
				entityType: 'notification',
				data: { type: 'needs_input' },
			})
			expect(matchesFilter(event, 'decision', actorsById)).toBe(true)
		})

		it('does not match notification without needs_input type', () => {
			const event = buildEventResponse({
				entityType: 'notification',
				data: { type: 'recommendation' },
			})
			expect(matchesFilter(event, 'decision', actorsById)).toBe(false)
		})

		it('does not match insight', () => {
			const event = buildEventResponse({ entityType: 'insight' })
			expect(matchesFilter(event, 'decision', actorsById)).toBe(false)
		})
	})

	describe('finding filter', () => {
		it('matches insight entity type', () => {
			const event = buildEventResponse({ entityType: 'insight' })
			expect(matchesFilter(event, 'finding', actorsById)).toBe(true)
		})

		it('does not match bet', () => {
			const event = buildEventResponse({ entityType: 'bet' })
			expect(matchesFilter(event, 'finding', actorsById)).toBe(false)
		})
	})

	describe('input filter', () => {
		it('matches notification entity type', () => {
			const event = buildEventResponse({ entityType: 'notification' })
			expect(matchesFilter(event, 'input', actorsById)).toBe(true)
		})

		it('does not match bet', () => {
			const event = buildEventResponse({ entityType: 'bet' })
			expect(matchesFilter(event, 'input', actorsById)).toBe(false)
		})
	})

	describe('agent filter', () => {
		it('matches events from agent actors', () => {
			const event = buildEventResponse({ actorId: 'agent-1' })
			expect(matchesFilter(event, 'agent', actorsById)).toBe(true)
		})

		it('does not match events from human actors', () => {
			const event = buildEventResponse({ actorId: 'human-1' })
			expect(matchesFilter(event, 'agent', actorsById)).toBe(false)
		})
	})

	describe('human filter', () => {
		it('matches events from human actors', () => {
			const event = buildEventResponse({ actorId: 'human-1' })
			expect(matchesFilter(event, 'human', actorsById)).toBe(true)
		})

		it('does not match events from agent actors', () => {
			const event = buildEventResponse({ actorId: 'agent-1' })
			expect(matchesFilter(event, 'human', actorsById)).toBe(false)
		})
	})

	describe('error filter', () => {
		it('matches failed actions', () => {
			const event = buildEventResponse({ action: 'session_failed' })
			expect(matchesFilter(event, 'error', actorsById)).toBe(true)
		})

		it('matches timeout actions', () => {
			const event = buildEventResponse({ action: 'session_timeout' })
			expect(matchesFilter(event, 'error', actorsById)).toBe(true)
		})

		it('does not match normal actions', () => {
			const event = buildEventResponse({ action: 'created' })
			expect(matchesFilter(event, 'error', actorsById)).toBe(false)
		})
	})
})
