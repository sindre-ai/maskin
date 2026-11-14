import { describe, expect, it } from 'vitest'
import { usagePercent } from '../plan-pricing'

describe('usagePercent', () => {
	it('is the share of the stored cap, rounded down', () => {
		expect(usagePercent(0, 286)).toBe(0)
		expect(usagePercent(120, 286)).toBe(41)
		expect(usagePercent(285, 286)).toBe(99)
	})

	it('reaches 100 exactly when work stops: at the cap, and over it', () => {
		expect(usagePercent(286, 286)).toBe(100)
		expect(usagePercent(900, 286)).toBe(100)
	})

	it('makes no figure up when the cap or the usage is unknown', () => {
		expect(usagePercent(10, null)).toBeNull()
		expect(usagePercent(10, 0)).toBeNull()
		expect(usagePercent(undefined, 286)).toBeNull()
		expect(usagePercent(Number.NaN, 286)).toBeNull()
	})
})
