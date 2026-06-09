import { describe, expect, it } from 'vitest'
import { checkGuestThrottle } from '../../lib/guest-throttle'
import { createTestContext } from '../setup'

const since = new Date('2026-01-01T00:00:00Z')

describe('checkGuestThrottle', () => {
	it('allows when count is below cap', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ count: 1 }]

		const result = await checkGuestThrottle(db, 'session-abc', 3, since)

		expect(result).toEqual({ allowed: true, count: 1 })
	})

	it('blocks when count equals cap', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ count: 3 }]

		const result = await checkGuestThrottle(db, 'session-abc', 3, since)

		expect(result).toEqual({ allowed: false, count: 3 })
	})

	it('blocks when count exceeds cap', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ count: 5 }]

		const result = await checkGuestThrottle(db, 'session-abc', 3, since)

		expect(result).toEqual({ allowed: false, count: 5 })
	})

	it('allows when count is zero', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ count: 0 }]

		const result = await checkGuestThrottle(db, 'session-abc', 3, since)

		expect(result).toEqual({ allowed: true, count: 0 })
	})

	it('treats missing count row as zero', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []

		const result = await checkGuestThrottle(db, 'session-abc', 3, since)

		expect(result).toEqual({ allowed: true, count: 0 })
	})
})
