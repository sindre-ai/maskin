import { describe, expect, it } from 'vitest'
import { formatAge } from '../../services/loop-escalation-reconciler'

/**
 * Unit coverage for the pure escalation-copy helper. The comment renders
 * verbatim into the escalation notification, so the compaction rule matters:
 * "12h 4m 33s" reads worse than "12h" to the person the escalation is paged
 * to. The DB-touching behaviour lives in the integration spec.
 */
describe('formatAge', () => {
	it('renders sub-minute durations in seconds', () => {
		expect(formatAge(1_000)).toBe('1s')
		expect(formatAge(59_999)).toBe('59s')
	})

	it('rounds down to whole minutes between 1m and 1h', () => {
		expect(formatAge(60_000)).toBe('1m')
		expect(formatAge(59 * 60_000 + 59_999)).toBe('59m')
	})

	it('rounds down to whole hours between 1h and 1d', () => {
		expect(formatAge(60 * 60_000)).toBe('1h')
		expect(formatAge(23 * 60 * 60_000 + 59 * 60_000)).toBe('23h')
	})

	it('rounds down to whole days above 24h', () => {
		expect(formatAge(24 * 60 * 60_000)).toBe('1d')
		expect(formatAge(7 * 24 * 60 * 60_000 + 12 * 60 * 60_000)).toBe('7d')
	})
})
