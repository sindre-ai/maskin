import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: vi.fn(() => ({}) as unknown),
		verifyStripeWebhook: vi.fn(),
	}
})

import { verifyStripeWebhook } from '../../lib/stripe'
import stripeWebhookRoutes from '../../routes/stripe-webhook'
import { createTestApp } from '../setup'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_STARTER: 'price_starter',
	STRIPE_PRICE_PRO: 'price_pro',
	MASKIN_STARTER_HARD_CAP_TOKENS: '32000000',
	MASKIN_PRO_HARD_CAP_TOKENS: '96000000',
}

const setupEnv = () => {
	for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v
}
const clearEnv = () => {
	for (const k of Object.keys(VALID_ENV)) delete process.env[k]
}

beforeEach(() => {
	vi.mocked(verifyStripeWebhook).mockReset()
	clearEnv()
	setupEnv()
})

function postWebhook(app: { request: (req: Request) => Promise<Response> }, body: object) {
	return app.request(
		new Request('http://localhost/api/webhooks/stripe', {
			method: 'POST',
			headers: { 'stripe-signature': 't=1,v1=abc' },
			body: JSON.stringify(body),
		}),
	)
}

type WorkspaceUpdate = { settings: { billing: Record<string, unknown> } }
function findWorkspaceUpdate(updates: unknown[]): WorkspaceUpdate {
	const match = updates.find(
		(u): u is WorkspaceUpdate =>
			!!u && typeof u === 'object' && 'settings' in (u as Record<string, unknown>),
	)
	if (!match) throw new Error('expected a workspace settings update; got none')
	return match
}

describe('POST /api/webhooks/stripe', () => {
	it('returns 401 when stripe-signature header is missing', async () => {
		const { app } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const res = await app.request(
			new Request('http://localhost/api/webhooks/stripe', {
				method: 'POST',
				body: '{}',
			}),
		)
		expect(res.status).toBe(401)
	})

	it('returns 401 when signature verification throws', async () => {
		const { app } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		vi.mocked(verifyStripeWebhook).mockImplementation(() => {
			throw new Error('bad signature')
		})
		const res = await postWebhook(app, {})
		expect(res.status).toBe(401)
	})

	it('acks events outside the handled allowlist', async () => {
		const { app } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_skip',
			type: 'charge.succeeded',
			data: { object: {} },
		} as unknown as Stripe.Event)
		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ skipped: true })
	})

	it('acks events that cannot be linked to a workspace', async () => {
		const { app } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_orphan',
			type: 'invoice.paid',
			data: { object: { metadata: null } },
		} as unknown as Stripe.Event)
		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ skipped: true, reason: 'no_workspace' })
	})

	it('falls back to settings.billing.stripe_customer_id when event has no metadata.workspace_id', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		// 1st select = resolver fallback (filtered lookup by stripe_customer_id),
		// 2nd select = applyEvent reading the workspace settings.
		mockResults.selectQueue = [
			[{ id: workspaceId }],
			[{ id: workspaceId, settings: { billing: { plan: 'starter', status: 'active' } } }],
		]
		mockResults.insertQueue = [[{ id: 'claim-fallback' }]]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_fallback',
			type: 'invoice.paid',
			data: { object: { customer: 'cus_fb', metadata: null } },
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		// The apply-handler ran (status flipped to active via invoice.paid) — proves
		// the resolver fallback returned the workspace, not a no_workspace skip.
		const update = calls.updates.find(
			(u): u is { settings: { billing: { status: string } } } =>
				!!u && typeof u === 'object' && 'settings' in (u as Record<string, unknown>),
		)
		expect(update?.settings.billing.status).toBe('active')
	})

	it('writes plan + customer/subscription to settings.billing on checkout.session.completed', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		// Claim insert succeeds; then the apply-handler select returns the workspace.
		mockResults.insertQueue = [[{ id: 'claim-1' }]]
		mockResults.selectQueue = [[{ id: workspaceId, settings: {} }]]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_checkout_1',
			type: 'checkout.session.completed',
			data: {
				object: {
					client_reference_id: workspaceId,
					customer: 'cus_42',
					subscription: 'sub_42',
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			stripe_customer_id: 'cus_42',
			stripe_subscription_id: 'sub_42',
			status: 'active',
		})
	})

	it('writes plan + cap on customer.subscription.updated', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-2' }]]
		mockResults.selectQueue = [[{ id: workspaceId, settings: {} }]]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_sub_upd',
			type: 'customer.subscription.updated',
			data: {
				object: {
					id: 'sub_99',
					customer: 'cus_99',
					status: 'active',
					current_period_start: 1_700_000_000,
					metadata: { workspace_id: workspaceId },
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			plan: 'pro',
			stripe_customer_id: 'cus_99',
			stripe_subscription_id: 'sub_99',
			status: 'active',
			hard_cap_tokens: 96_000_000,
			period_start: 1_700_000_000,
		})
	})

	it('downgrades to byollm on customer.subscription.deleted', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-3' }]]
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_x' },
					},
				},
			],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_sub_del',
			type: 'customer.subscription.deleted',
			data: {
				object: {
					id: 'sub_x',
					customer: 'cus_x',
					status: 'canceled',
					canceled_at: 1_700_001_000,
					metadata: { workspace_id: workspaceId },
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			plan: 'byollm',
			stripe_subscription_id: null,
			status: 'canceled',
		})
	})

	it('flips status to past_due on invoice.payment_failed', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-4' }]]
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: { billing: { plan: 'starter', status: 'active' } } }],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_inv_failed',
			type: 'invoice.payment_failed',
			data: {
				object: {
					customer: 'cus_y',
					metadata: { workspace_id: workspaceId },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({ plan: 'starter', status: 'past_due' })
	})

	it('marks the webhook_deliveries claim as processed on success', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-mark' }]]
		mockResults.selectQueue = [[{ id: workspaceId, settings: {} }]]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_mark',
			type: 'invoice.paid',
			data: { object: { metadata: { workspace_id: workspaceId } } },
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		// Without marking processedAt, the WebhookDeliveriesReconciler deletes the
		// claim 15m after receipt, collapsing the idempotency window from Stripe's
		// ~3-day retry envelope down to 15m and letting late retries re-apply
		// stale state mutations.
		const claimUpdate = calls.updates.find(
			(u): u is { processedAt: Date } =>
				!!u && typeof u === 'object' && 'processedAt' in (u as Record<string, unknown>),
		)
		expect(claimUpdate?.processedAt).toBeInstanceOf(Date)
	})

	it('short-circuits duplicate deliveries via webhook_deliveries dedup', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		// Empty insert result means onConflictDoNothing matched → duplicate path.
		mockResults.insertQueue = [[]]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_dup',
			type: 'invoice.paid',
			data: { object: { customer: 'cus_d', metadata: { workspace_id: workspaceId } } },
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ duplicate: true })
		// And critically — no workspace update was attempted.
		expect(calls.updates).toHaveLength(0)
	})
})
