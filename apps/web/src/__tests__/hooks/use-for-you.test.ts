import { forYouItemToFeedItem } from '@/hooks/use-for-you'
import type { ForYouItem } from '@/lib/api'

function buildForYouItem(overrides: Partial<ForYouItem> = {}): ForYouItem {
	return {
		notification_id: 'n-1',
		rank: 1,
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
})
