import { describe, expect, it } from 'vitest'

import type { LatestMention, LatestMentionDecision, UnreadItem } from '@/lib/api'
import {
	actionIdFromLabel,
	cardActions,
	cardHeadline,
	classifyCardKind,
	decisionOf,
	recommendedAction,
} from '@/lib/foryou-card-kind'
import { buildObjectResponse } from '../factories'

function buildDecision(overrides: Partial<LatestMentionDecision> = {}): LatestMentionDecision {
	return {
		title: 'Is the onboarding bet worth running?',
		summary: '3 of 5 signups stall on step 2. I have drafted the copy.',
		ask: 'This changes what every customer sees first, so I will not ship it alone.',
		options: [
			{ label: 'Hold', consequences: ['Nothing ships this cycle', 'Keeps losing 40 a week'] },
			{
				label: '7-day window',
				recommended: true,
				consequences: ['Ships with cycle 1 tomorrow', 'Adds 18 tickets in week one'],
			},
		],
		...overrides,
	}
}

function buildMention(overrides: Partial<LatestMention> = {}): LatestMention {
	return {
		event_id: 1,
		actor_id: null,
		created_at: '2026-09-01T00:00:00.000Z',
		content: 'Body of the comment.',
		truncated: false,
		attention: null,
		decision: null,
		...overrides,
	}
}

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
	it('returns decision when the agent attached a decision block', () => {
		const item = buildItem({ latest_mention: buildMention({ decision: buildDecision() }) })
		expect(classifyCardKind(item)).toBe('decision')
	})

	it('returns thread for a mention with no decision', () => {
		expect(classifyCardKind(buildItem({ latest_mention: buildMention() }))).toBe('thread')
	})

	// The kind used to be inferred from the object's type and status, which
	// meant an object could look decision-shaped while the agent had asked
	// nothing. Only the agent decides now.
	it('returns thread for a review-status task with no decision block', () => {
		const item = buildItem({
			object: buildObjectResponse({ id: 'obj-1', type: 'task', status: 'in_review' }),
			latest_mention: buildMention(),
		})
		expect(classifyCardKind(item)).toBe('thread')
	})

	it('returns thread when there is no mention payload at all', () => {
		expect(classifyCardKind(buildItem())).toBe('thread')
		expect(decisionOf(buildItem())).toBeNull()
	})
})

describe('cardActions', () => {
	it('builds one action per agent-authored option, carrying its consequences', () => {
		const item = buildItem({ latest_mention: buildMention({ decision: buildDecision() }) })
		const actions = cardActions(item)
		expect(actions.map((action) => action.label)).toEqual(['Hold', '7-day window'])
		expect(actions[1]?.consequences).toEqual([
			'Ships with cycle 1 tomorrow',
			'Adds 18 tickets in week one',
		])
	})

	it('sorts the recommended option last, where the filled bar sits', () => {
		const decision = buildDecision({
			options: [
				{ label: 'Ship now', recommended: true, consequences: ['Goes out today', 'No rollback'] },
				{ label: 'Hold', consequences: ['Nothing ships', 'Costs a week'] },
			],
		})
		const actions = cardActions(buildItem({ latest_mention: buildMention({ decision }) }))
		expect(actions.at(-1)?.label).toBe('Ship now')
	})

	it('returns no actions for a plain mention', () => {
		expect(cardActions(buildItem({ latest_mention: buildMention() }))).toEqual([])
	})
})

describe('recommendedAction', () => {
	it('returns the option the agent would take', () => {
		const item = buildItem({ latest_mention: buildMention({ decision: buildDecision() }) })
		expect(recommendedAction(item)?.label).toBe('7-day window')
	})

	// Bulk "take every suggested option" must skip these rather than guessing.
	it('returns undefined when nothing is recommended', () => {
		const decision = buildDecision({
			options: [
				{ label: 'Hold', consequences: ['Nothing ships', 'Costs a week'] },
				{ label: 'Ship', consequences: ['Goes out today', 'No rollback'] },
			],
		})
		expect(
			recommendedAction(buildItem({ latest_mention: buildMention({ decision }) })),
		).toBeUndefined()
		expect(recommendedAction(buildItem())).toBeUndefined()
	})
})

describe('actionIdFromLabel', () => {
	it('slugs a label into a stable analytics id', () => {
		expect(actionIdFromLabel('7-day window')).toBe('7_day_window')
		expect(actionIdFromLabel('Hold')).toBe('hold')
	})

	it('falls back rather than emitting an empty id', () => {
		expect(actionIdFromLabel('!!!')).toBe('option')
	})
})

describe('cardHeadline', () => {
	it('leads with the decision title', () => {
		const item = buildItem({ latest_mention: buildMention({ decision: buildDecision() }) })
		expect(cardHeadline(item)).toBe('Is the onboarding bet worth running?')
	})

	it('falls back to the comment first line when there is no decision', () => {
		const item = buildItem({
			latest_mention: buildMention({ content: 'Can you confirm the date?' }),
		})
		expect(cardHeadline(item)).toBe('Can you confirm the date?')
	})

	it('skips markdown scaffolding when picking that line', () => {
		const item = buildItem({
			latest_mention: buildMention({ content: '## Heading\n\n- Can you confirm the date?' }),
		})
		expect(cardHeadline(item)).toBe('Heading')
	})

	// An item with no mention payload still has to render something.
	it('falls back to the object title, then to Untitled', () => {
		expect(cardHeadline(buildItem())).toBe(
			buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'active' }).title,
		)
		expect(cardHeadline(buildItem({ object: undefined }))).toBe('Untitled')
	})
})
