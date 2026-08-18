import { describe, expect, it } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import {
	AFTER_DECISION_FALLBACK_CHIPS,
	CARD_ACTIONS,
	QUICK_REPLY_CHIPS,
	afterDecisionChips,
	classifyCardKind,
} from '@/lib/foryou-card-kind'
import { buildObjectResponse } from '../factories'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 0,
		mentioning_unread_count: 0,
		max_unread_attention: null,
		latest_event_id: null,
		latest_activity_at: null,
		object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'active' }),
		...overrides,
	}
}

describe('classifyCardKind', () => {
	it('classifies the first-use context card as its own decision-weight kind', () => {
		const item = buildItem({
			object: buildObjectResponse({
				type: 'onboarding_session',
				status: 'active',
				metadata: { source: 'workspace_first_use', first_use_card: 'context' },
			}),
		})
		expect(classifyCardKind(item)).toBe('first_use')
	})

	it.each(['intro', 'suggestions'])(
		'classifies the first-use %s card as a plain thread',
		(card) => {
			const item = buildItem({
				object: buildObjectResponse({
					type: 'onboarding_session',
					status: 'active',
					metadata: { source: 'workspace_first_use', first_use_card: card },
				}),
			})
			expect(classifyCardKind(item)).toBe('thread')
		},
	)

	it('classifies an onboarding session with no card marker as a thread', () => {
		const item = buildItem({
			object: buildObjectResponse({ type: 'onboarding_session', status: 'active' }),
		})
		expect(classifyCardKind(item)).toBe('thread')
	})

	it.each(['ux', 'architecture', 'copy', 'pricing'])(
		'classifies a task in in_review with decision_type=%s as a decision card',
		(decisionType) => {
			const item = buildItem({
				object: buildObjectResponse({
					type: 'task',
					status: 'in_review',
					metadata: { decision_type: decisionType },
				}),
			})
			expect(classifyCardKind(item)).toBe('decision')
		},
	)

	it('classifies a task in in_review with no decision_type as a sign_off card', () => {
		const item = buildItem({
			object: buildObjectResponse({ type: 'task', status: 'in_review' }),
		})
		expect(classifyCardKind(item)).toBe('sign_off')
	})

	// Regression lock for the bug this task fixes: `in_review` is not a valid
	// status for type `bet` (see workspace schema — bet accepts signal / qualified
	// / define / active / live / succeeded / failed / paused / archived). A bet
	// can never be in_review in prod, so the classifier must not key `decision`
	// off `bet.status`. This test would fail if a reviewer tries to re-introduce
	// the old bet→decision branch.
	it('never classifies a bet as a decision card (bet has no in_review status in schema)', () => {
		for (const status of [
			'signal',
			'qualified',
			'define',
			'active',
			'live',
			'succeeded',
			'failed',
			'paused',
			'archived',
			'in_review',
		]) {
			const item = buildItem({
				object: buildObjectResponse({ type: 'bet', status }),
			})
			expect(classifyCardKind(item)).not.toBe('decision')
		}
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

	it('carries a one-line rationale on the decision option rows only, not on chips', () => {
		for (const action of CARD_ACTIONS.decision) {
			expect(action.rationale).toBeTruthy()
		}
		for (const action of [
			...CARD_ACTIONS.sign_off,
			...CARD_ACTIONS.proposed_bet,
			...QUICK_REPLY_CHIPS,
		]) {
			expect(action.rationale).toBeUndefined()
		}
	})
})

describe('afterDecisionChips', () => {
	it('drops chips that echo the first word of a decision option', () => {
		const labels = afterDecisionChips().map((chip) => chip.label)
		// "Approved" overlaps the "Approve" option's head word.
		expect(labels).not.toContain('Approved')
		expect(labels).toContain('On it')
		expect(labels).toContain('Need more context')
	})

	it('falls back to forward-looking chips when the filter empties the row', () => {
		const kept = afterDecisionChips(CARD_ACTIONS.decision, [
			{ id: 'approved', label: 'Approved', tone: 'secondary' },
			{ id: 'send_it_back', label: 'Send it back', tone: 'secondary' },
		])
		expect(kept).toEqual(AFTER_DECISION_FALLBACK_CHIPS)
	})

	it('keeps every chip when no option head word overlaps', () => {
		const kept = afterDecisionChips(
			[{ id: 'ship', label: 'Ship', tone: 'primary' }],
			QUICK_REPLY_CHIPS,
		)
		expect(kept).toEqual(QUICK_REPLY_CHIPS)
	})
})
