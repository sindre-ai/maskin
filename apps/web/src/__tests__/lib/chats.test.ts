import { buildSessionResponse } from '@/__tests__/factories'
import {
	formatChatCountLabel,
	getChatRowSnippet,
	getRecencyBucket,
	groupSessionsByRecency,
	sessionStateLabel,
} from '@/lib/chats'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-07-05T12:00:00Z')

function iso(daysAgo: number, hour = 10): string {
	const d = new Date(NOW)
	d.setDate(d.getDate() - daysAgo)
	d.setHours(hour, 0, 0, 0)
	return d.toISOString()
}

describe('getRecencyBucket', () => {
	it('returns today for the same calendar day', () => {
		expect(getRecencyBucket(iso(0), NOW)).toBe('today')
	})

	it('returns yesterday for one calendar day back', () => {
		expect(getRecencyBucket(iso(1), NOW)).toBe('yesterday')
	})

	it('returns this-week for 2–7 days back', () => {
		expect(getRecencyBucket(iso(2), NOW)).toBe('this-week')
		expect(getRecencyBucket(iso(7), NOW)).toBe('this-week')
	})

	it('returns earlier beyond a week', () => {
		expect(getRecencyBucket(iso(8), NOW)).toBe('earlier')
	})

	it('falls back to earlier for null or invalid dates', () => {
		expect(getRecencyBucket(null, NOW)).toBe('earlier')
		expect(getRecencyBucket('not-a-date', NOW)).toBe('earlier')
	})
})

describe('groupSessionsByRecency', () => {
	it('groups sessions and orders buckets newest first', () => {
		const groups = groupSessionsByRecency(
			[
				buildSessionResponse({ id: 's-old', createdAt: iso(20) }),
				buildSessionResponse({ id: 's-today', createdAt: iso(0) }),
				buildSessionResponse({ id: 's-week', createdAt: iso(3) }),
				buildSessionResponse({ id: 's-yesterday', createdAt: iso(1) }),
			],
			NOW,
		)

		expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'this-week', 'earlier'])
		expect(groups.map((g) => g.items[0].id)).toEqual(['s-today', 's-yesterday', 's-week', 's-old'])
	})

	it('uses the most recent of updatedAt/createdAt/startedAt for bucketing', () => {
		const groups = groupSessionsByRecency(
			[buildSessionResponse({ id: 's', createdAt: iso(10), updatedAt: iso(0) })],
			NOW,
		)
		expect(groups[0].bucket).toBe('today')
	})

	it('omits empty buckets', () => {
		const groups = groupSessionsByRecency(
			[buildSessionResponse({ id: 's', createdAt: iso(1) })],
			NOW,
		)
		expect(groups.map((g) => g.bucket)).not.toContain('earlier')
	})
})

describe('formatChatCountLabel', () => {
	it('singularizes one conversation', () => {
		expect(formatChatCountLabel(1)).toBe('1 conversation')
	})

	it('pluralizes multiple conversations', () => {
		expect(formatChatCountLabel(4)).toBe('4 conversations')
	})
})

describe('getChatRowSnippet', () => {
	it('returns trimmed current activity', () => {
		expect(getChatRowSnippet({ currentActivity: '  working on it  ' } as never)).toBe(
			'working on it',
		)
	})

	it('returns empty string when there is no activity', () => {
		expect(getChatRowSnippet({ currentActivity: null } as never)).toBe('')
	})
})

describe('sessionStateLabel', () => {
	it('maps known statuses to friendly labels', () => {
		expect(sessionStateLabel('running')).toBe('Working')
		expect(sessionStateLabel('completed')).toBe('Done')
		expect(sessionStateLabel('failed')).toBe('Failed')
	})

	it('falls back to the raw status for unknown values', () => {
		expect(sessionStateLabel('weird-status')).toBe('weird-status')
	})
})
