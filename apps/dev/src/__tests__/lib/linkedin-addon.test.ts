import { describe, expect, it } from 'vitest'
import {
	LINKEDIN_IDENTITY_PROVIDER,
	LINKEDIN_IDENTITY_UNIT_PRICE_EUR_CENTS,
	resolveLinkedInIdentityAddon,
} from '../../lib/linkedin-addon'

describe('resolveLinkedInIdentityAddon', () => {
	it('returns null when the feature flag is off, regardless of connected count', () => {
		expect(resolveLinkedInIdentityAddon({ connectedCount: 0, flagOn: false })).toBeNull()
		expect(resolveLinkedInIdentityAddon({ connectedCount: 3, flagOn: false })).toBeNull()
	})

	it('returns null when the flag is on but no identities are connected', () => {
		expect(resolveLinkedInIdentityAddon({ connectedCount: 0, flagOn: true })).toBeNull()
	})

	it('returns null when the connected count is negative (defensive; count() should never do this)', () => {
		expect(resolveLinkedInIdentityAddon({ connectedCount: -1, flagOn: true })).toBeNull()
	})

	it('returns a line with count × €29 when the flag is on and identities are connected', () => {
		expect(resolveLinkedInIdentityAddon({ connectedCount: 1, flagOn: true })).toEqual({
			count: 1,
			unit_price_eur_cents: 2900,
			monthly_total_eur_cents: 2900,
		})
		expect(resolveLinkedInIdentityAddon({ connectedCount: 4, flagOn: true })).toEqual({
			count: 4,
			unit_price_eur_cents: 2900,
			monthly_total_eur_cents: 11_600,
		})
	})

	it('pins the €29 unit price and provider name so drift trips a test rather than a customer', () => {
		// Sebk-locked in the pricing memo (bet §Pricing). Any change here must be
		// paired with an operator update to the Stripe Product/Price ID stored under
		// STRIPE_PRICE_LINKEDIN_IDENTITY, or the plan surface will display a
		// different number than Stripe charges.
		expect(LINKEDIN_IDENTITY_UNIT_PRICE_EUR_CENTS).toBe(2900)
		// Must match the `provider` value written by Task 2's Unipile hosted-wizard
		// callback — the SKU-count query joins on this literal.
		expect(LINKEDIN_IDENTITY_PROVIDER).toBe('linkedin-unipile')
	})
})
