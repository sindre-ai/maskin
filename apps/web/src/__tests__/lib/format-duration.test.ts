import { describe, expect, it, vi } from 'vitest'
import { formatDurationBetween, formatDurationMs } from '@/lib/format-duration'

describe('formatDurationMs', () => {
	it('formats seconds', () => {
		expect(formatDurationMs(5000)).toBe('5s')
	})

	it('formats zero seconds', () => {
		expect(formatDurationMs(0)).toBe('0s')
	})

	it('formats minutes and seconds', () => {
		expect(formatDurationMs(90_000)).toBe('1m 30s')
	})

	it('formats exact minutes', () => {
		expect(formatDurationMs(120_000)).toBe('2m 0s')
	})

	it('formats hours and minutes', () => {
		expect(formatDurationMs(3_660_000)).toBe('1h 1m')
	})

	it('formats exact hours', () => {
		expect(formatDurationMs(7_200_000)).toBe('2h 0m')
	})

	it('floors sub-second values', () => {
		expect(formatDurationMs(1500)).toBe('1s')
	})
})

describe('formatDurationBetween', () => {
	it('returns null when startedAt is null', () => {
		expect(formatDurationBetween(null, null)).toBeNull()
	})

	it('formats duration between two dates', () => {
		const start = '2025-01-01T00:00:00Z'
		const end = '2025-01-01T00:01:30Z'
		expect(formatDurationBetween(start, end)).toBe('1m 30s')
	})

	it('uses Date.now() when completedAt is null', () => {
		const now = new Date('2025-06-15T12:00:30Z').getTime()
		vi.spyOn(Date, 'now').mockReturnValue(now)
		const start = '2025-06-15T12:00:00Z'
		expect(formatDurationBetween(start, null)).toBe('30s')
		vi.restoreAllMocks()
	})
})
