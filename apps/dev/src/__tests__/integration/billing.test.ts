import { events, billing as billingTable, invoices as invoicesTable } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedPlan, StripeLike } from '../../lib/stripe'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { createBillingApp } = await import('../../routes/billing')

const PRO_PLAN: ResolvedPlan = {
	planId: 'pro',
	planLabel: 'Pro',
	priceCents: 12000,
	currency: 'usd',
	priceId: 'price_test_1',
}

function createStripeStub(options: { workspaceId?: string; intentStatus?: string } = {}) {
	const { workspaceId, intentStatus = 'succeeded' } = options
	return {
		customers: {
			create: vi.fn(async () => ({ id: `cus_test_${Math.random().toString(36).slice(2, 8)}` })),
		},
		paymentIntents: {
			create: vi.fn(async () => ({
				id: 'pi_test_1',
				client_secret: 'pi_test_1_secret_xyz',
			})),
			retrieve: vi.fn(async (id: string) => ({
				id,
				status: intentStatus,
				amount: PRO_PLAN.priceCents,
				currency: PRO_PLAN.currency,
				metadata: { workspace_id: workspaceId ?? '' },
			})),
		},
		prices: {
			retrieve: vi.fn(async () => ({
				id: PRO_PLAN.priceId as string,
				nickname: PRO_PLAN.planLabel,
				unit_amount: PRO_PLAN.priceCents,
				currency: PRO_PLAN.currency,
			})),
		},
		billingPortal: {
			sessions: {
				create: vi.fn(async () => ({ url: 'https://billing.stripe.com/session/test' })),
			},
		},
	} as unknown as StripeLike
}

function createTestApp(stripe: StripeLike | null) {
	const app = createBillingApp({
		stripe,
		resolvePlan: async () => PRO_PLAN,
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		await next()
	})
	return app
}

async function getBillingRow(workspaceId: string) {
	const [row] = await db
		.select()
		.from(billingTable)
		.where(eq(billingTable.workspaceId, workspaceId))
		.limit(1)
	return row
}

describe('Billing Integration — Stripe checkout lifecycle', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	it('returns free-plan defaults + empty invoices before any checkout', async () => {
		const res = await createTestApp(createStripeStub()).request(
			jsonRequest('GET', '/api/billing', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.configured).toBe(true)
		expect(body.plan).toMatchObject({ planId: 'free', status: 'inactive', priceCents: null })
		expect(body.invoiceEmail).toBeNull()
		expect(body.invoices).toEqual([])
	})

	it('reports configured:false when Stripe is unset and rejects checkout', async () => {
		const app = createTestApp(null)
		const summary = await app.request(
			jsonRequest('GET', '/api/billing', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(summary.status).toBe(200)
		expect((await summary.json()).configured).toBe(false)

		const checkout = await app.request(
			jsonRequest('POST', '/api/billing/checkout', {}, { 'x-workspace-id': workspaceId }),
		)
		expect(checkout.status).toBe(400)
	})

	it('checkout snapshots the plan as pending, then complete activates it + creates customer + invoice', async () => {
		const app = createTestApp(createStripeStub({ workspaceId }))

		const checkoutRes = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{ invoiceEmail: 'billing@acme.dev' },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(checkoutRes.status).toBe(200)
		const { clientSecret, plan } = await checkoutRes.json()
		expect(clientSecret).toBe('pi_test_1_secret_xyz')
		expect(plan).toMatchObject({ planId: 'pro', status: 'pending', priceCents: 12000 })

		const pendingRow = await getBillingRow(workspaceId)
		expect(pendingRow?.status).toBe('pending')
		expect(pendingRow?.invoiceEmail).toBe('billing@acme.dev')
		expect(pendingRow?.stripePriceId).toBe(PRO_PLAN.priceId)

		const completeRes = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(completeRes.status).toBe(200)
		const body = await completeRes.json()
		expect(body.plan).toMatchObject({ planId: 'pro', status: 'active', priceCents: 12000 })
		expect(body.invoiceEmail).toBe('billing@acme.dev')
		expect(body.invoices).toHaveLength(1)
		expect(body.invoices[0]).toMatchObject({
			description: 'Pro plan — monthly',
			amountCents: 12000,
			currency: 'usd',
			status: 'paid',
		})

		const activeRow = await getBillingRow(workspaceId)
		expect(activeRow?.status).toBe('active')
		expect(activeRow?.stripeCustomerId).toMatch(/^cus_test_/)

		const [billingEvent] = await db
			.select()
			.from(events)
			.where(eq(events.workspaceId, workspaceId))
			.orderBy(events.id)
		expect(billingEvent.entityType).toBe('billing')
	})

	it('complete is idempotent per payment intent — no double invoice', async () => {
		const app = createTestApp(createStripeStub({ workspaceId }))
		for (const _ of [1, 2]) {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/billing/complete',
					{ paymentIntentId: 'pi_test_1' },
					{
						'x-workspace-id': workspaceId,
					},
				),
			)
			expect(res.status).toBe(200)
		}
		const rows = await db
			.select()
			.from(invoicesTable)
			.where(eq(invoicesTable.workspaceId, workspaceId))
		expect(rows).toHaveLength(1)
	})

	it('marks the plan declined when the payment intent did not succeed', async () => {
		const app = createTestApp(
			createStripeStub({ workspaceId, intentStatus: 'requires_payment_method' }),
		)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(res.status).toBe(400)
		expect((await res.json()).error.message).toContain('declined')
		expect((await getBillingRow(workspaceId))?.status).toBe('declined')
	})

	it('rejects completing a payment intent from a different workspace', async () => {
		const otherWorkspace = await insertWorkspace(db, getTestActorId())
		const app = createTestApp(createStripeStub({ workspaceId: otherWorkspace.id }))
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(res.status).toBe(400)
		// One generic message for both unknown-intent and wrong-workspace so a
		// member cannot probe arbitrary payment-intent ids.
		expect((await res.json()).error.message).toContain('Unable to verify')
	})

	it('serializes concurrent confirms of the same intent — exactly one invoice + one customer', async () => {
		const stub = createStripeStub({ workspaceId })
		const app = createTestApp(stub)

		// No sequential warm-up: the race is the point. All three run against a
		// fresh workspace; the partial unique index lets exactly one insert win.
		const results = await Promise.all(
			[1, 2, 3].map(() =>
				app.request(
					jsonRequest(
						'POST',
						'/api/billing/complete',
						{ paymentIntentId: 'pi_test_1' },
						{
							'x-workspace-id': workspaceId,
						},
					),
				),
			),
		)
		for (const res of results) expect(res.status).toBe(200)

		const rows = await db
			.select()
			.from(invoicesTable)
			.where(eq(invoicesTable.workspaceId, workspaceId))
		expect(rows).toHaveLength(1)
		expect(stub.customers.create).toHaveBeenCalledTimes(1)
		expect((await getBillingRow(workspaceId))?.status).toBe('active')
	})

	it('keeps an active plan active across checkouts — no demotion to pending', async () => {
		const app = createTestApp(createStripeStub({ workspaceId }))
		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{ invoiceEmail: 'billing@acme.dev' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{ 'x-workspace-id': workspaceId },
			),
		)

		const res = await app.request(
			jsonRequest('POST', '/api/billing/checkout', undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		expect((await res.json()).plan.status).toBe('active')
		expect((await getBillingRow(workspaceId))?.status).toBe('active')
	})

	it('does not demote an active plan when a change-plan re-pay is declined', async () => {
		const app = createTestApp(createStripeStub({ workspaceId }))
		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{ invoiceEmail: 'billing@acme.dev' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{ 'x-workspace-id': workspaceId },
			),
		)

		const declineApp = createTestApp(
			createStripeStub({ workspaceId, intentStatus: 'requires_payment_method' }),
		)
		const res = await declineApp.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_2' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
		expect((await getBillingRow(workspaceId))?.status).toBe('active')
	})

	it('keeps the portal behind a persisted Stripe customer', async () => {
		const stub = createStripeStub({ workspaceId })
		const app = createTestApp(stub)

		const before = await app.request(
			jsonRequest('POST', '/api/billing/portal', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(before.status).toBe(400)

		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		const after = await app.request(
			jsonRequest('POST', '/api/billing/portal', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(after.status).toBe(200)
		expect((await after.json()).url).toBe('https://billing.stripe.com/session/test')
		expect(stub.customers.create).toHaveBeenCalled()
	})

	it('lists invoices newest-first, including ones inserted outside the route', async () => {
		const app = createTestApp(createStripeStub({ workspaceId }))
		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/complete',
				{ paymentIntentId: 'pi_test_1' },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		const yesterday = new Date(Date.now() - 86_400_000)
		const [older] = await db
			.insert(invoicesTable)
			.values({
				workspaceId,
				description: 'Older plan — monthly',
				amountCents: 9000,
				currency: 'usd',
				status: 'paid',
				billedAt: yesterday,
			})
			.returning()

		const res = await app.request(
			jsonRequest('GET', '/api/billing', undefined, { 'x-workspace-id': workspaceId }),
		)
		const body = await res.json()
		expect(body.invoices).toHaveLength(2)
		expect(body.invoices[0].id).not.toBe(older.id)
		expect(body.invoices[1].id).toBe(older.id)
	})
})
