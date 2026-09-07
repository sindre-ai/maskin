import { describe, expect, it } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { bucketRank, compactTime, feedItemKey, feedTailLabel, heldNote } from '@/lib/foryou-feed'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentioning_unread_count: 0,
		max_unread_attention: null,
		latest_event_id: 10,
		latest_activity_at: '2026-08-19T09:00:00.000Z',
		...overrides,
	}
}

describe('compactTime', () => {
	it('counts up through minutes, hours and days', () => {
		expect(compactTime('2026-08-19T11:59:30.000Z', NOW)).toBe('NOW')
		expect(compactTime('2026-08-19T11:41:00.000Z', NOW)).toBe('19M')
		expect(compactTime('2026-08-19T07:00:00.000Z', NOW)).toBe('5H')
		expect(compactTime('2026-08-17T12:00:00.000Z', NOW)).toBe('2D')
	})

	it('falls back to a date once a week has passed', () => {
		expect(compactTime('2026-08-01T12:00:00.000Z', NOW)).toMatch(/AUG/)
	})

	it('renders nothing without a timestamp', () => {
		expect(compactTime(null, NOW)).toBe('')
		expect(compactTime('not-a-date', NOW)).toBe('')
	})
})

describe('heldNote', () => {
	it('says nothing for anything younger than a day', () => {
		expect(heldNote('2026-08-19T07:00:00.000Z', NOW)).toBe('')
	})

	it('counts whole days, and rounds off past a week', () => {
		expect(heldNote('2026-08-18T09:00:00.000Z', NOW)).toBe('held 1 day')
		expect(heldNote('2026-08-16T09:00:00.000Z', NOW)).toBe('held 3 days')
		expect(heldNote('2026-08-01T09:00:00.000Z', NOW)).toBe('held over a week')
	})
})

describe('feedItemKey', () => {
	it('keys an item by its entity type and id', () => {
		expect(feedItemKey(buildItem({ entity_id: 'x' }))).toBe('object:x')
	})
})

describe('bucketRank', () => {
	it('orders decisions before waiting, FYI and handled', () => {
		expect(bucketRank('needs')).toBeLessThan(bucketRank('waiting'))
		expect(bucketRank('waiting')).toBeLessThan(bucketRank('fyi'))
		expect(bucketRank('fyi')).toBeLessThan(bucketRank('done'))
	})
})

describe('feedTailLabel', () => {
	it('explains an empty feed differently when a filter is on', () => {
		expect(feedTailLabel({ filtered: false })).toBe('Feed cleared')
		expect(feedTailLabel({ filtered: true })).toBe('Nothing of this kind in the feed')
	})
})
