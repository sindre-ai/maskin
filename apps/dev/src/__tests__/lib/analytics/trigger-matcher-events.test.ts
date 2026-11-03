import { describe, expect, it } from 'vitest'
import { detectSuspiciousFilterEntries } from '../../../lib/analytics/trigger-matcher-events'

/**
 * Pins the write-time warning shape the triggers route emits as
 * `trigger_config_suspicious`. Scalars and arrays are healthy; a plain object
 * or `null` is what the matcher will never resolve (tech spec §2.3, last
 * paragraph). Kept as a pure helper test — the route wiring itself is exercised
 * from the trigger integration path.
 */
describe('detectSuspiciousFilterEntries', () => {
	it('returns [] for a healthy filter of scalars and arrays', () => {
		expect(
			detectSuspiciousFilterEntries({
				status: 'onboarding',
				attention: 4,
				tags: ['a', 'b'],
			}),
		).toEqual([])
	})

	it('flags a null value', () => {
		expect(detectSuspiciousFilterEntries({ status: null })).toEqual([
			{ key: 'status', shape: 'null_value' },
		])
	})

	it('flags a non-array object value', () => {
		expect(detectSuspiciousFilterEntries({ status: { eq: 'onboarding' } })).toEqual([
			{ key: 'status', shape: 'object_value' },
		])
	})

	it('leaves arrays alone (they are the valid any-of shape)', () => {
		expect(detectSuspiciousFilterEntries({ status: ['a', 'b'] })).toEqual([])
	})

	it('returns one entry per suspicious key, preserving iteration order', () => {
		expect(
			detectSuspiciousFilterEntries({
				status: null,
				attention: 4,
				extra: { nested: true },
			}),
		).toEqual([
			{ key: 'status', shape: 'null_value' },
			{ key: 'extra', shape: 'object_value' },
		])
	})

	it.each([undefined, null, {}])('handles %p as a no-op', (input) => {
		expect(detectSuspiciousFilterEntries(input as never)).toEqual([])
	})
})
