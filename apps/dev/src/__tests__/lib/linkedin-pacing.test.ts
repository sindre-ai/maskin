import { describe, expect, it } from 'vitest'
import { WARMUP_DAYS, computeWarmupProgress, derivePacing } from '../../lib/linkedin/pacing'

describe('derivePacing', () => {
	it('returns healthy caps (20/80) for a healthy account', () => {
		const p = derivePacing('healthy', new Date('2026-07-10T00:00:00Z'))
		expect(p.dailyCap).toBe(20)
		expect(p.weeklyCap).toBe(80)
		expect(p.warmup).toBeNull()
	})

	it('returns warm-up caps (5/25) and a warm-up progress block for warm_up state', () => {
		const p = derivePacing('warm_up', new Date('2026-07-10T00:00:00Z'))
		expect(p.dailyCap).toBe(5)
		expect(p.weeklyCap).toBe(25)
		expect(p.warmup).not.toBeNull()
		expect(p.warmup?.total).toBe(WARMUP_DAYS)
	})

	it('returns zero caps for restricted (agent is blocked from sending)', () => {
		const p = derivePacing('restricted', new Date())
		expect(p.dailyCap).toBe(0)
		expect(p.weeklyCap).toBe(0)
	})

	it('returns zero caps for reconnect (agent is paused)', () => {
		const p = derivePacing('reconnect', new Date())
		expect(p.dailyCap).toBe(0)
		expect(p.weeklyCap).toBe(0)
	})

	it('returns zero caps while syncing (no sends until first-sync completes)', () => {
		const p = derivePacing('syncing', new Date())
		expect(p.dailyCap).toBe(0)
		expect(p.weeklyCap).toBe(0)
	})

	it('starts warm-up sent counters at zero — pacing display defaults until T3 lands sends', () => {
		const p = derivePacing('warm_up', new Date())
		expect(p.dailySent).toBe(0)
		expect(p.weeklySent).toBe(0)
	})
})

describe('computeWarmupProgress', () => {
	it('returns null when connectedAt is missing', () => {
		expect(computeWarmupProgress(null)).toBeNull()
	})

	it('is on day 1 immediately after connect', () => {
		const now = new Date()
		const w = computeWarmupProgress(now)
		expect(w).toEqual({ day: 1, total: WARMUP_DAYS })
	})

	it('caps at WARMUP_DAYS when connectedAt is older than the warm-up window', () => {
		const long_ago = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
		const w = computeWarmupProgress(long_ago)
		expect(w?.day).toBe(WARMUP_DAYS)
	})

	it('advances day count with elapsed time', () => {
		const three_days = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
		const w = computeWarmupProgress(three_days)
		expect(w?.day).toBe(4)
	})

	it('treats a future connectedAt as day 1 rather than a negative day', () => {
		const future = new Date(Date.now() + 60 * 60 * 1000)
		const w = computeWarmupProgress(future)
		expect(w).toEqual({ day: 1, total: WARMUP_DAYS })
	})
})
