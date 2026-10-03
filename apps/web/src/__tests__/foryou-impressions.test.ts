import { __resetImpressionsForTesting, markImpressed } from '@/lib/foryou-impressions'
import { afterEach, describe, expect, it } from 'vitest'

// Module-scoped Set persists across tests; reset per-test so the dedup boundary
// under test is the one this module enforces (per-tab session), not test order.
afterEach(() => {
	__resetImpressionsForTesting()
})

describe('markImpressed', () => {
	it('returns true on first call for a card and false on repeats', () => {
		expect(markImpressed('card-a')).toBe(true)
		expect(markImpressed('card-a')).toBe(false)
		expect(markImpressed('card-a')).toBe(false)
	})

	it('dedups per card_id — different cards each get one true', () => {
		expect(markImpressed('card-a')).toBe(true)
		expect(markImpressed('card-b')).toBe(true)
		expect(markImpressed('card-a')).toBe(false)
		expect(markImpressed('card-b')).toBe(false)
	})
})
