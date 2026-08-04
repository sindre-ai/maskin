import { describe, expect, it } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { CARD_ACTIONS, classifyCardKind } from '@/lib/foryou-card-kind'
import { buildObjectResponse } from '../factories'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 0,
		mentioning_unread_count: 0,
		latest_event_id: null,
		latest_activity_at: null,
		object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'active' }),
		...overrides,
	}
}

describe('classifyCardKind', () => {
	it('classifies a bet in in_review as a decision card', () => {
		const item = buildItem({
			object: buildObjectResponse({ type: 'bet', status: 'in_review' }),
		})
		expect(classifyCardKind(item)).toBe('decision')
	})

	it('classifies a task in in_review as a sign_off card', () => {
		const item = buildItem({
			object: buildObjectResponse({ type: 'task', status: 'in_review' }),
		})
		expect(classifyCardKind(item)).toBe('sign_off')
	})

	it.each(['signal', 'proposed', 'define', 'clustered'])(
		'classifies a bet in %s as a proposed_bet card',
		(status) => {
			const item = buildItem({
				object: buildObjectResponse({ type: 'bet', status }),
			})
			expect(classifyCardKind(item)).toBe('proposed_bet')
		},
	)

	it('falls back to thread when the object type/status combination is unknown', () => {
		const item = buildItem({
			object: buildObjectResponse({ type: 'bet', status: 'active' }),
		})
		expect(classifyCardKind(item)).toBe('thread')
	})

	it('falls back to thread when the item has no object', () => {
		const item = buildItem({ object: undefined })
		expect(classifyCardKind(item)).toBe('thread')
	})
})

describe('CARD_ACTIONS', () => {
	it('defines a primary decision action so the shaded footer has a filled CTA', () => {
		expect(CARD_ACTIONS.decision[0]?.tone).toBe('primary')
	})

	it('defines the sign_off and proposed_bet action sets required by the design directions', () => {
		expect(CARD_ACTIONS.sign_off.map((a) => a.id)).toEqual(['sign_off', 'send_back', 'snooze_24h'])
		expect(CARD_ACTIONS.proposed_bet.map((a) => a.id)).toEqual(['open_bet', 'refine', 'dismiss'])
	})
})
