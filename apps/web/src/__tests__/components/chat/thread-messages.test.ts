import { isOldThread } from '@/components/chat/thread-messages'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-08-18T12:00:00Z')

describe('isOldThread', () => {
	it('marks a thread untouched for over a month as history', () => {
		expect(isOldThread('2026-06-01T12:00:00Z', NOW)).toBe(true)
	})

	it('leaves a recent thread alone', () => {
		expect(isOldThread('2026-08-10T12:00:00Z', NOW)).toBe(false)
	})

	it('says nothing when there is no timestamp to judge by', () => {
		expect(isOldThread(null, NOW)).toBe(false)
		expect(isOldThread('not-a-date', NOW)).toBe(false)
	})
})
