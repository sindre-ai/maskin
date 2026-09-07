import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { countMock } = vi.hoisted(() => ({ countMock: vi.fn() }))
vi.mock('../../lib/linkedin-addon', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/linkedin-addon')>()),
	getConnectedLinkedInIdentityCount: countMock,
}))

import { syncLinkedInAddonQuantity } from '../../lib/linkedin-addon-billing'
import type { StripeEnv } from '../../lib/stripe'

const env: StripeEnv = {
	secretKey: 'sk_test',
	webhookSecret: 'whsec_test',
	pricePro: 'price_pro',
	priceTeam: 'price_team',
	proHardCapUsdCents: 1000,
	teamHardCapUsdCents: 2000,
	priceLinkedinIdentity: 'price_linkedin',
}

/** Minimal db stub: one workspace row, and a recorded update. */
function makeDb(billing: Record<string, unknown>) {
	const updates: Array<Record<string, unknown>> = []
	const row = { id: 'ws-1', settings: { billing } }
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [row] }) }),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				updates.push(values)
				return { where: async () => undefined }
			},
		}),
	} as unknown as Database
	return { db, updates }
}

function makeStripe() {
	return {
		subscriptionItems: {
			create: vi.fn().mockResolvedValue({ id: 'si_new' }),
			update: vi.fn().mockResolvedValue({ id: 'si_1' }),
			del: vi.fn().mockResolvedValue({ id: 'si_1', deleted: true }),
		},
	}
}

beforeEach(() => {
	countMock.mockReset()
})

describe('syncLinkedInAddonQuantity', () => {
	it('creates an item on the plan subscription for a pro workspace', async () => {
		countMock.mockResolvedValue(1)
		const { db, updates } = makeDb({ plan: 'pro', stripe_subscription_id: 'sub_plan' })
		const stripe = makeStripe()

		const res = await syncLinkedInAddonQuantity(db, 'ws-1', {
			stripe: stripe as never,
			env,
		})

		expect(res).toEqual({ status: 'synced', quantity: 1 })
		expect(stripe.subscriptionItems.create).toHaveBeenCalledWith(
			expect.objectContaining({
				subscription: 'sub_plan',
				price: 'price_linkedin',
				quantity: 1,
			}),
		)
		// The item id has to be persisted or the next sync creates a SECOND
		// item and the workspace is billed twice for one identity.
		const billing = (updates[0]?.settings as { billing: Record<string, unknown> }).billing
		expect(billing.linkedin_addon_item_id).toBe('si_new')
	})

	it('sets quantity to the recomputed count, not an increment', async () => {
		countMock.mockResolvedValue(3)
		const { db } = makeDb({ plan: 'team', linkedin_addon_item_id: 'si_1' })
		const stripe = makeStripe()

		await syncLinkedInAddonQuantity(db, 'ws-1', { stripe: stripe as never, env })

		expect(stripe.subscriptionItems.update).toHaveBeenCalledWith(
			'si_1',
			expect.objectContaining({ quantity: 3 }),
		)
	})

	it('does not prorate a quantity decrease — the identity stays paid to period end', async () => {
		countMock.mockResolvedValue(1)
		const { db } = makeDb({ plan: 'pro', linkedin_addon_item_id: 'si_1' })
		const stripe = makeStripe()

		await syncLinkedInAddonQuantity(db, 'ws-1', { stripe: stripe as never, env })

		expect(stripe.subscriptionItems.update).toHaveBeenCalledWith(
			'si_1',
			expect.objectContaining({ proration_behavior: 'none' }),
		)
	})

	it('removes the item rather than billing a $0 line when the last identity goes', async () => {
		countMock.mockResolvedValue(0)
		const { db, updates } = makeDb({ plan: 'pro', linkedin_addon_item_id: 'si_1' })
		const stripe = makeStripe()

		const res = await syncLinkedInAddonQuantity(db, 'ws-1', { stripe: stripe as never, env })

		expect(res).toEqual({ status: 'removed' })
		expect(stripe.subscriptionItems.del).toHaveBeenCalledWith(
			'si_1',
			expect.objectContaining({ proration_behavior: 'none' }),
		)
		expect(stripe.subscriptionItems.update).not.toHaveBeenCalled()
		const billing = (updates[0]?.settings as { billing: Record<string, unknown> }).billing
		expect(billing.linkedin_addon_item_id).toBeNull()
	})

	it('reports checkout_required for a trial workspace with no subscription', async () => {
		countMock.mockResolvedValue(1)
		const { db } = makeDb({ plan: 'trial' })
		const stripe = makeStripe()

		const res = await syncLinkedInAddonQuantity(db, 'ws-1', { stripe: stripe as never, env })

		expect(res).toEqual({ status: 'checkout_required', quantity: 1 })
		expect(stripe.subscriptionItems.create).not.toHaveBeenCalled()
	})

	// A Stripe outage must not undo a connect the user already completed in
	// Unipile's wizard — the identity works, and the next sync re-reconciles.
	it('swallows a Stripe failure instead of throwing into the connect flow', async () => {
		countMock.mockResolvedValue(1)
		const { db } = makeDb({ plan: 'pro', stripe_subscription_id: 'sub_plan' })
		const stripe = makeStripe()
		stripe.subscriptionItems.create.mockRejectedValue(new Error('stripe down'))

		const res = await syncLinkedInAddonQuantity(db, 'ws-1', { stripe: stripe as never, env })

		expect(res).toEqual({ status: 'noop', reason: 'stripe_error' })
	})

	// Connecting still has to work in a deployment that never created the
	// Stripe Product — it just is not billed, loudly, in the logs.
	it('no-ops when the add-on price is not configured', async () => {
		countMock.mockResolvedValue(1)
		const { db } = makeDb({ plan: 'pro', stripe_subscription_id: 'sub_plan' })
		const stripe = makeStripe()

		const res = await syncLinkedInAddonQuantity(db, 'ws-1', {
			stripe: stripe as never,
			env: { ...env, priceLinkedinIdentity: null },
		})

		expect(res).toEqual({ status: 'noop', reason: 'price_not_configured' })
		expect(stripe.subscriptionItems.create).not.toHaveBeenCalled()
	})
})
