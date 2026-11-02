import { dismissBodyFor, forYouItemToFeedItem } from '@/hooks/use-for-you'
import type { ForYouItem } from '@/lib/api'

function buildForYouItem(overrides: Partial<ForYouItem> = {}): ForYouItem {
	return {
		notification_id: 'n-1',
		source: 'curated',
		rank: 1,
		latest_event_id: null,
		headline: 'Approve the launch',
		rationale: null,
		created_at: '2026-10-18T08:00:00.000Z',
		entity_type: 'object',
		entity_id: 'o-1',
		session_id: null,
		...overrides,
	}
}

describe('forYouItemToFeedItem', () => {
	it('uses the source comment as the high-water mark a dismissal moves', () => {
		const item = forYouItemToFeedItem(
			buildForYouItem({
				latest_mention: {
					event_id: 42,
					actor_id: 'a-1',
					created_at: '2026-10-18T09:00:00.000Z',
					content: 'Ship it?',
					attention: 4,
					decision: null,
				},
			}),
		)
		expect(item).toMatchObject({
			entity_type: 'object',
			entity_id: 'o-1',
			latest_event_id: 42,
			max_unread_attention: 4,
			latest_activity_at: '2026-10-18T09:00:00.000Z',
		})
	})

	it('falls back to the notification time when no source comment is attached', () => {
		const item = forYouItemToFeedItem(buildForYouItem())
		expect(item?.latest_event_id).toBeNull()
		expect(item?.latest_activity_at).toBe('2026-10-18T08:00:00.000Z')
	})

	it('drops an item that points at no object, since the feed cannot open it', () => {
		expect(forYouItemToFeedItem(buildForYouItem({ entity_id: null, entity_type: null }))).toBeNull()
	})

	it('maps a decision card that has no notification behind it', () => {
		const item = forYouItemToFeedItem(
			buildForYouItem({
				notification_id: null,
				source: 'decision',
				latest_mention: {
					event_id: 77,
					actor_id: 'a-2',
					created_at: '2026-10-20T09:00:00.000Z',
					content: 'Send the note?',
					attention: 3,
					decision: null,
				},
			}),
		)
		expect(item?.entity_id).toBe('o-1')
		expect(item?.latest_event_id).toBe(77)
	})

	it('keeps the headline and rationale, and takes its own read position when there is no comment', () => {
		const item = forYouItemToFeedItem(
			buildForYouItem({
				headline: 'Graduate 5 wiki pages',
				rationale: 'Only you can approve voice.',
				latest_event_id: 321,
			}),
		)
		expect(item?.curated).toEqual({
			headline: 'Graduate 5 wiki pages',
			rationale: 'Only you can approve voice.',
			notification_id: 'n-1',
		})
		expect(item?.latest_event_id).toBe(321)
	})
})

describe('dismissBodyFor', () => {
	const mention = {
		event_id: 77,
		actor_id: 'a-2',
		created_at: '2026-10-20T09:00:00.000Z',
		content: 'Send the note?',
		attention: 3,
		decision: null,
	}

	it('names the notification of a curated card', () => {
		const item = forYouItemToFeedItem(buildForYouItem({ latest_mention: mention }))
		expect(item && dismissBodyFor(item)).toEqual({ notification_id: 'n-1' })
	})

	it('names the comment that raised a decision card, which has no notification', () => {
		const item = forYouItemToFeedItem(
			buildForYouItem({ notification_id: null, source: 'decision', latest_mention: mention }),
		)
		expect(item && dismissBodyFor(item)).toEqual({ source_comment_id: 77 })
	})

	it('has nothing to name for a card with neither', () => {
		const item = forYouItemToFeedItem(buildForYouItem({ notification_id: null }))
		expect(item && dismissBodyFor(item)).toBeNull()
	})
})
