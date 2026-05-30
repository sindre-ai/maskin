import { describe, expect, it } from 'vitest'
import {
	COOKIE_DRAFT_CAP,
	PER_IP_PER_DAY_CAP,
	PER_IP_PER_MINUTE_CAP,
	checkGuestThrottle,
} from '../../lib/guest-throttle'
import { createTestContext } from '../setup'

const WS = '00000000-0000-0000-0001-000000000002'

describe('checkGuestThrottle', () => {
	it('allows when all counts are below caps', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]]
		const verdict = await checkGuestThrottle(db, {
			workspaceId: WS,
			guestSessionId: 'g1',
			ip: '203.0.113.1',
		})
		expect(verdict).toEqual({ allowed: true })
	})

	it('rejects with cookie_quota when at the cap', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[{ count: COOKIE_DRAFT_CAP }]]
		const verdict = await checkGuestThrottle(db, {
			workspaceId: WS,
			guestSessionId: 'g1',
			ip: '203.0.113.1',
		})
		expect(verdict).toEqual({ allowed: false, reason: 'cookie_quota' })
	})

	it('rejects with ip_rate when the per-minute IP cap is hit', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[{ count: 0 }], [{ count: PER_IP_PER_MINUTE_CAP }]]
		const verdict = await checkGuestThrottle(db, {
			workspaceId: WS,
			guestSessionId: 'g1',
			ip: '203.0.113.1',
		})
		expect(verdict).toEqual({ allowed: false, reason: 'ip_rate' })
	})

	it('rejects with ip_daily when the per-day IP cap is hit', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }], [{ count: PER_IP_PER_DAY_CAP }]]
		const verdict = await checkGuestThrottle(db, {
			workspaceId: WS,
			guestSessionId: 'g1',
			ip: '203.0.113.1',
		})
		expect(verdict).toEqual({ allowed: false, reason: 'ip_daily' })
	})
})
