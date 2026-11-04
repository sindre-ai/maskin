import { describe, expect, it } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import {
	type FeedBucket,
	bucketRank,
	compactTime,
	dismissableItems,
	feedItemKey,
	feedKindFilter,
	feedKindOf,
	feedTailLabel,
	heldNote,
} from '@/lib/foryou-feed'
import { leadLine } from '@/routes/_authed/$workspaceId/index'

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
		expect(bucketRank('done')).toBeLessThan(bucketRank('later'))
	})
})

describe('feedTailLabel', () => {
	it('explains an empty feed differently when a filter is on', () => {
		expect(feedTailLabel({ filtered: false })).toBe('Feed cleared')
		expect(feedTailLabel({ filtered: true })).toBe('Nothing here')
	})
})

describe('dismissableItems', () => {
	it('leaves every card that is waiting on the person out of a bulk dismiss', () => {
		const buckets: Record<string, FeedBucket> = {
			a: 'needs',
			b: 'fyi',
			c: 'waiting',
			d: 'done',
			e: 'needs',
		}
		const items = Object.keys(buckets)
		expect(dismissableItems(items, (id) => buckets[id] as FeedBucket)).toEqual(['b', 'c', 'd'])
	})

	it('leaves cards set aside with Later out of a bulk dismiss', () => {
		const buckets: Record<string, FeedBucket> = { a: 'later', b: 'fyi', c: 'later' }
		expect(dismissableItems(Object.keys(buckets), (id) => buckets[id] as FeedBucket)).toEqual(['b'])
	})
})

describe('leadLine', () => {
	it('counts decisions only, and never says nothing to decide while one is open', () => {
		expect(leadLine(1, 3)).toBe('One decision is waiting on you')
		expect(leadLine(4, 0)).toBe('4 decisions are waiting on you')
		expect(leadLine(0, 2)).toBe('Nothing to decide, 2 updates for you')
		expect(leadLine(0, 0)).toBe('You are clear')
	})
})

describe('feedKindOf', () => {
	const mention = (extra: Record<string, unknown> = {}) =>
		buildItem({
			latest_mention: {
				event_id: 1,
				actor_id: null,
				created_at: '2026-08-19T09:00:00.000Z',
				content: 'Done.',
				attention: null,
				decision: null,
				...extra,
			} as UnreadItem['latest_mention'],
		})

	it('calls a note that asks nothing an update', () => {
		expect(feedKindOf(mention())).toBe('update')
	})

	it('calls a note with a question a decision', () => {
		expect(feedKindOf(mention({ content: 'Ship it?' }))).toBe('decision')
	})

	it('calls an ask with a message to send a draft', () => {
		const decision = { title: 'Send it?', options: [], drafts: [{ id: 'a', body: 'Hi' }] }
		expect(feedKindOf(mention({ decision }))).toBe('draft')
	})
})

describe('feedKindFilter', () => {
	it('keeps a card kind', () => {
		expect(feedKindFilter('update')).toBe('update')
	})

	it('treats a leftover item-type value as no filter', () => {
		expect(feedKindFilter('task')).toBeUndefined()
		expect(feedKindFilter('toString')).toBeUndefined()
		expect(feedKindFilter(undefined)).toBeUndefined()
	})
})
