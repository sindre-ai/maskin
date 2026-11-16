import type { LatestMentionDecision, UnreadItem } from '@/lib/api'
import {
	cardContextLabel,
	cardDeadline,
	cardWhyYou,
	deadlineChipText,
	deadlineRowText,
} from '@/lib/foryou-card-context'
import { describe, expect, it } from 'vitest'

function item(overrides: Partial<UnreadItem> = {}, decision: Partial<LatestMentionDecision> = {}) {
	return {
		entity_type: 'object',
		entity_id: 'task-1',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: null,
		latest_event_id: 1,
		latest_activity_at: null,
		latest_mention: {
			event_id: 1,
			actor_id: 'agent-1',
			created_at: '2026-11-16T10:00:00Z',
			content: 'x',
			attention: null,
			decision: { title: 'Q?', summary: 'S', options: [], ...decision },
		},
		...overrides,
	} as UnreadItem
}

// Noon local time, so the day maths does not depend on the machine's zone.
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()
const at = (day: number, hour = 17) => new Date(2026, 10, day, hour, 0, 0).toISOString()

describe('cardContextLabel', () => {
	it('names an event as "For the event" and a bet as "For"', () => {
		expect(
			cardContextLabel(item({ context: { id: 'e', type: 'event', title: 'Product evening' } })),
		).toBe('For the event: Product evening')
		expect(cardContextLabel(item({ context: { id: 'b', type: 'bet', title: 'Autumn' } }))).toBe(
			'For: Autumn',
		)
	})

	it('is null without a context or a title, never an empty label', () => {
		expect(cardContextLabel(item())).toBeNull()
		expect(cardContextLabel(item({ context: { id: 'e', type: 'event', title: ' ' } }))).toBeNull()
	})
})

describe('cardDeadline', () => {
	it('takes the due date, else the writer expiry, else nothing', () => {
		expect(cardDeadline(item({ due_at: '2026-11-18T09:00:00Z' }, { expires_at: at(20) }))).toBe(
			'2026-11-18T09:00:00Z',
		)
		expect(cardDeadline(item({ due_at: null }, { expires_at: at(20) }))).toBe(at(20))
		expect(cardDeadline(item())).toBeNull()
		expect(cardDeadline(item({ due_at: 'not a date' }))).toBeNull()
	})
})

describe('deadlineChipText', () => {
	it('counts the days left', () => {
		expect(deadlineChipText(at(18), NOW)).toBe('Answer by Wed 18 Nov, 2 days left')
		expect(deadlineChipText(at(17), NOW)).toBe('Answer by Tue 17 Nov, 1 day left')
	})

	it('says today when it is today and still ahead', () => {
		expect(deadlineChipText(at(16), NOW)).toBe('Answer by today')
	})

	it('says was due once it has passed', () => {
		expect(deadlineChipText(at(14), NOW)).toBe('Was due Sat 14 Nov')
		expect(deadlineChipText(at(16, 9), NOW)).toBe('Was due Mon 16 Nov')
	})

	it('keeps only the date on a list row', () => {
		expect(deadlineRowText(at(18), NOW)).toBe('Answer by Wed 18 Nov')
	})
})

describe('cardWhyYou', () => {
	it('is the writer ask, or null when they gave none', () => {
		expect(cardWhyYou(item({}, { ask: ' I will not send this alone. ' }))).toBe(
			'I will not send this alone.',
		)
		expect(cardWhyYou(item({}, { ask: '' }))).toBeNull()
		expect(cardWhyYou(item({ latest_mention: undefined }))).toBeNull()
	})
})
