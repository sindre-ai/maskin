import { describe, expect, it } from 'vitest'
import {
	LINKEDIN_IDENTITY_PROVIDER,
	LINKEDIN_IDENTITY_UNIT_PRICE_USD_CENTS,
	resolveLinkedInIdentityAddon,
} from '../../lib/linkedin-addon'

describe('resolveLinkedInIdentityAddon', () => {
	it('returns null when the feature flag is off, regardless of connected count', () => {
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 0, flagOn: false, exempt: false }),
		).toBeNull()
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 3, flagOn: false, exempt: false }),
		).toBeNull()
	})

	it('returns null when the flag is on but no identities are connected', () => {
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 0, flagOn: true, exempt: false }),
		).toBeNull()
	})

	it('returns null when the connected count is negative (defensive; count() should never do this)', () => {
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: -1, flagOn: true, exempt: false }),
		).toBeNull()
	})

	it('returns a line with count × $49 when the flag is on and identities are connected', () => {
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 1, flagOn: true, exempt: false }),
		).toEqual({
			count: 1,
			unit_price_usd_cents: 4900,
			monthly_total_usd_cents: 4900,
		})
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 4, flagOn: true, exempt: false }),
		).toEqual({
			count: 4,
			unit_price_usd_cents: 4900,
			monthly_total_usd_cents: 19_600,
		})
	})

	it('returns null for an enterprise workspace, however many identities are connected', () => {
		// Enterprise workspaces get connected identities free — same entitlement
		// that exempts them from the plan spend cap and credit debiting. There is
		// no line because there is no charge; syncLinkedInAddonQuantity likewise
		// creates no Stripe item for them.
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 1, flagOn: true, exempt: true }),
		).toBeNull()
		expect(
			resolveLinkedInIdentityAddon({ connectedCount: 9, flagOn: true, exempt: true }),
		).toBeNull()
	})

	it('pins the $49 unit price and provider name so drift trips a test rather than a customer', () => {
		// Sebk-locked at $49 USD in the pricing memo (bet §Pricing, updated
		// 2026-09-02). Any change here must be paired with an operator update
		// to the Stripe Product/Price ID stored under
		// STRIPE_PRICE_LINKEDIN_IDENTITY, or the plan surface will display a
		// different number than Stripe charges.
		expect(LINKEDIN_IDENTITY_UNIT_PRICE_USD_CENTS).toBe(4900)
		// Must match the `provider` value written by Task 2's Unipile hosted-wizard
		// callback — the SKU-count query joins on this literal.
		expect(LINKEDIN_IDENTITY_PROVIDER).toBe('linkedin-unipile')
	})
})
