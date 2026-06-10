import { computeUnreadEventIds } from '@/components/activity/object-activity'
import { buildEventResponse } from '../../factories'

describe('computeUnreadEventIds', () => {
	it('returns empty set when events is undefined', () => {
		expect(computeUnreadEventIds(undefined, 3).size).toBe(0)
	})

	it('returns empty set when unreadCount is 0', () => {
		const events = [buildEventResponse({ id: 1, action: 'commented' })]
		expect(computeUnreadEventIds(events, 0).size).toBe(0)
	})

	it('returns empty set when unreadCount is negative', () => {
		const events = [buildEventResponse({ id: 1, action: 'commented' })]
		expect(computeUnreadEventIds(events, -1).size).toBe(0)
	})

	it('returns empty set when no events are comments', () => {
		const events = [
			buildEventResponse({ id: 1, action: 'created' }),
			buildEventResponse({ id: 2, action: 'status_changed' }),
		]
		expect(computeUnreadEventIds(events, 2).size).toBe(0)
	})

	it('returns the N most recent comment event ids by descending id', () => {
		const events = [
			buildEventResponse({ id: 10, action: 'commented' }),
			buildEventResponse({ id: 20, action: 'commented' }),
			buildEventResponse({ id: 30, action: 'commented' }),
		]
		const result = computeUnreadEventIds(events, 2)
		expect(result).toEqual(new Set([30, 20]))
	})

	it('returns all comment ids when unreadCount exceeds comment count', () => {
		const events = [
			buildEventResponse({ id: 5, action: 'commented' }),
			buildEventResponse({ id: 7, action: 'commented' }),
		]
		const result = computeUnreadEventIds(events, 10)
		expect(result).toEqual(new Set([5, 7]))
	})

	it('ignores non-comment events when selecting the most recent', () => {
		const events = [
			buildEventResponse({ id: 1, action: 'commented' }),
			buildEventResponse({ id: 2, action: 'status_changed' }),
			buildEventResponse({ id: 3, action: 'commented' }),
			buildEventResponse({ id: 4, action: 'created' }),
			buildEventResponse({ id: 5, action: 'commented' }),
		]
		// Only events 5 and 3 are the 2 most-recent comments
		const result = computeUnreadEventIds(events, 2)
		expect(result).toEqual(new Set([5, 3]))
	})

	it('handles events arriving in any order', () => {
		const events = [
			buildEventResponse({ id: 30, action: 'commented' }),
			buildEventResponse({ id: 10, action: 'commented' }),
			buildEventResponse({ id: 20, action: 'commented' }),
		]
		const result = computeUnreadEventIds(events, 1)
		expect(result).toEqual(new Set([30]))
	})

	it('returns empty set when events array is empty', () => {
		expect(computeUnreadEventIds([], 5).size).toBe(0)
	})
})
