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

// Plan-shaped deliveries now write an audit `events` row, which resolves the
// shared 'Stripe' system actor (and its workspace membership) first. The mock
// DB falls back to the static `select` result once `selectQueue` is drained,
// so seeding it with an actor row lets those two extra reads resolve without
// every test having to queue them. Rows already queued are unaffected.
const STRIPE_SYSTEM_ACTOR = [{ id: '00000000-0000-4000-8000-0000000000aa' }]

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_PRO: 'price_pro',
	STRIPE_PRICE_TEAM: 'price_team',
	MASKIN_PRO_HARD_CAP_USD_CENTS: '2000',
	MASKIN_TEAM_HARD_CAP_USD_CENTS: '20000',
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
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[{ id: workspaceId }],
			[{ id: workspaceId, settings: { billing: { plan: 'pro', status: 'active' } } }],
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
		mockResults.select = STRIPE_SYSTEM_ACTOR
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

	it('clears stale period_end on checkout.session.completed so the re-subscribe banner does not show', async () => {
		// Re-subscriber: their previous Pro period ended (period_end in the past).
		// checkout.session.completed arrives before customer.subscription.created; the
		// stale period bounds must be cleared so the billing route falls back to a
		// future estimate rather than returning period_resets_in_ms=0.
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-stale' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'canceled',
							period_start: 1_700_000_000,
							period_end: 1_702_592_000, // past timestamp
							stripe_subscription_id: 'sub_old',
						},
					},
				},
			],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_checkout_restarter',
			type: 'checkout.session.completed',
			data: {
				object: {
					client_reference_id: workspaceId,
					customer: 'cus_new',
					subscription: 'sub_new',
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			stripe_customer_id: 'cus_new',
			stripe_subscription_id: 'sub_new',
			status: 'active',
			period_start: null,
			period_end: null,
		})
	})

	it('preserves a future period_end from an out-of-order customer.subscription.created on checkout.session.completed', async () => {
		// Out-of-order delivery: customer.subscription.created arrived before
		// checkout.session.completed and already set a future period_end. The
		// checkout handler must NOT clear valid future period data.
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		// A future period_end (year 2099 in Unix seconds)
		const futurePeriodEnd = 4_070_908_800
		mockResults.insertQueue = [[{ id: 'claim-future' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							period_start: 1_700_000_000,
							period_end: futurePeriodEnd,
							stripe_subscription_id: 'sub_42',
						},
					},
				},
			],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_checkout_oo',
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
			status: 'active',
			period_end: futurePeriodEnd,
		})
	})

	it('writes plan + cap on customer.subscription.updated', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-2' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
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
					current_period_end: 1_702_592_000,
					metadata: { workspace_id: workspaceId },
					items: { data: [{ price: { id: 'price_team' } }] },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			plan: 'team',
			stripe_customer_id: 'cus_99',
			stripe_subscription_id: 'sub_99',
			status: 'active',
			hard_cap_usd_cents: 20_000,
			period_start: 1_700_000_000,
			period_end: 1_702_592_000,
		})
	})

	it('downgrades an unentitled workspace to trial on customer.subscription.deleted', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-3' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'team', status: 'active', stripe_subscription_id: 'sub_x' },
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
					items: { data: [{ price: { id: 'price_team' } }] },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		// NOT 'byollm'. That plan sits at the top of PLAN_TIER_ORDER with null
		// (unlimited) seat and ownership caps, so writing it here let any
		// workspace self-grant unlimited seats + unlimited workspace ownership
		// by cancelling its subscription. It also routes nowhere — 'byollm' is
		// excluded from MASKIN_PLAN_ROUTED_PLANS, so the workspace could start
		// no sessions at all. Unentitled cancellations land on 'trial'.
		expect(update.settings.billing).toMatchObject({
			plan: 'trial',
			stripe_subscription_id: null,
			status: 'canceled',
		})
	})

	it('downgrades a byollm-entitled workspace to byollm on customer.subscription.deleted', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-3b' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					byollmAllowed: true,
					settings: {
						billing: { plan: 'team', status: 'active', stripe_subscription_id: 'sub_y' },
					},
				},
			],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_sub_del_entitled',
			type: 'customer.subscription.deleted',
			data: {
				object: {
					id: 'sub_y',
					customer: 'cus_y',
					status: 'canceled',
					canceled_at: 1_700_001_000,
					metadata: { workspace_id: workspaceId },
					items: { data: [{ price: { id: 'price_team' } }] },
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
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: { billing: { plan: 'pro', status: 'active' } } }],
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
		expect(update.settings.billing).toMatchObject({ plan: 'pro', status: 'past_due' })
	})

	it('writes period_start and period_end on invoice.paid', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-inv' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: { billing: { plan: 'pro', status: 'active' } } }],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_inv_paid',
			type: 'invoice.paid',
			data: {
				object: {
					metadata: { workspace_id: workspaceId },
					period_start: 1_700_000_000,
					period_end: 1_702_592_000,
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			status: 'active',
			period_start: 1_700_000_000,
			period_end: 1_702_592_000,
		})
	})

	it('marks the webhook_deliveries claim as processed on success', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-mark' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
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

	it('preserves fields across interleaved deliveries (lost-update regression)', async () => {
		// Two Stripe webhooks for the same workspace land within seconds:
		//   delivery A: customer.subscription.created — writes plan, hard_cap_usd_cents, period_start
		//   delivery B: checkout.session.completed   — writes stripe_customer_id, stripe_subscription_id, status
		// Without SELECT … FOR UPDATE inside a transaction, B can read settings
		// before A's UPDATE commits, mutate its own slice, and clobber A's plan
		// + cap on UPDATE. With the fix in place, B's transaction blocks on the
		// row lock until A commits, then re-reads the merged state — so its
		// final UPDATE carries both A's and B's fields.
		//
		// The mock DB can't simulate Postgres locking, so we model the expected
		// post-lock behaviour: B's select returns the settings A committed, and
		// we assert B's UPDATE preserves A's plan/cap alongside its own writes.
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()

		// Two claims (one per delivery) and two selects: A reads {}, B reads
		// the billing slice A would have committed.
		// Each delivery inserts twice: the webhook_deliveries claim, then the
		// audit events row. Without the events slots, delivery B's claim would
		// shift delivery A's events result, read as 0 rows, and be dropped as a
		// duplicate before it ever wrote.
		mockResults.insertQueue = [
			[{ id: 'claim-a' }],
			[{ id: 'evt-a' }],
			[{ id: 'claim-b' }],
			[{ id: 'evt-b' }],
		]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		// Both deliveries write an audit row, and resolving the system actor
		// costs two extra selects each — spelled out here so delivery B's
		// workspace row isn't consumed by delivery A's actor lookup.
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: {} }],
			STRIPE_SYSTEM_ACTOR,
			[{ workspaceId }],
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'team',
							status: 'active',
							hard_cap_usd_cents: 20_000,
							period_start: 1_700_000_000,
							stripe_subscription_id: 'sub_42',
							stripe_customer_id: 'cus_42',
						},
					},
				},
			],
			STRIPE_SYSTEM_ACTOR,
			[{ workspaceId }],
		]

		vi.mocked(verifyStripeWebhook)
			.mockReturnValueOnce({
				id: 'evt_sub_created',
				type: 'customer.subscription.created',
				data: {
					object: {
						id: 'sub_42',
						customer: 'cus_42',
						status: 'active',
						current_period_start: 1_700_000_000,
						metadata: { workspace_id: workspaceId },
						items: { data: [{ price: { id: 'price_team' } }] },
					},
				},
			} as unknown as Stripe.Event)
			.mockReturnValueOnce({
				id: 'evt_checkout',
				type: 'checkout.session.completed',
				data: {
					object: {
						client_reference_id: workspaceId,
						customer: 'cus_42',
						subscription: 'sub_42',
					},
				},
			} as unknown as Stripe.Event)

		const resA = await postWebhook(app, {})
		expect(resA.status).toBe(200)
		const resB = await postWebhook(app, {})
		expect(resB.status).toBe(200)

		const workspaceUpdates = calls.updates.filter(
			(u): u is WorkspaceUpdate =>
				!!u && typeof u === 'object' && 'settings' in (u as Record<string, unknown>),
		)
		expect(workspaceUpdates).toHaveLength(2)
		// The final write must merge A's plan/cap with B's customer/subscription —
		// the lost-update bug would surface here as plan='trial' or missing cap.
		expect(workspaceUpdates[1]?.settings.billing).toMatchObject({
			plan: 'team',
			hard_cap_usd_cents: 20_000,
			period_start: 1_700_000_000,
			stripe_customer_id: 'cus_42',
			stripe_subscription_id: 'sub_42',
			status: 'active',
		})
	})

	it('credits the balance on a mode:payment credit_topup checkout, without touching plan/status/period_*', async () => {
		// The specific collision risk: a payment-mode checkout.session.completed
		// must never fall into the subscription-mirroring branch below it.
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [
			[{ id: 'claim-topup' }], // webhook delivery claim
			[{ id: 'ledger-topup-1' }], // workspace_credit_ledger claim
			[{ id: 'system-actor-topup' }], // create Stripe system actor (not found → created)
			[], // create workspace member row for the system actor
			[], // events insert
		]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							hard_cap_usd_cents: 2_000,
							period_start: 1_700_000_000,
							period_end: 1_702_592_000,
							stripe_customer_id: 'cus_existing',
							stripe_subscription_id: 'sub_existing',
							credit_balance_cents: 1_000,
						},
					},
				},
			],
			[], // system actor lookup — not found
			[], // workspace member lookup — not found
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_credit_topup',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_credit_1',
					mode: 'payment',
					client_reference_id: workspaceId,
					metadata: { workspace_id: workspaceId, kind: 'credit_topup', amount_usd_cents: '2500' },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)

		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			plan: 'pro',
			status: 'active',
			period_start: 1_700_000_000,
			period_end: 1_702_592_000,
			stripe_customer_id: 'cus_existing',
			stripe_subscription_id: 'sub_existing',
			credit_balance_cents: 3_500,
		})

		const eventInsert = calls.inserts.find(
			(i): i is { action: string; workspaceId: string } =>
				!!i &&
				typeof i === 'object' &&
				(i as Record<string, unknown>).action === 'workspace_credit_topup',
		)
		expect(eventInsert).toBeDefined()
		expect(eventInsert?.workspaceId).toBe(workspaceId)
	})

	it('does not re-credit the balance when the same credit_topup checkout is redelivered', async () => {
		// Regression: the balance delta used to be applied before the ledger
		// claim, so the partial unique index on stripe_checkout_session_id
		// suppressed only the audit row while the money was credited again.
		// Stripe retries for ~3 days and two replay paths exist by design (the
		// dedup-claim fail-open, and a released claim after a failed
		// processed_at mark), so a redelivery must leave the balance untouched.
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [
			[{ id: 'claim-topup-replay' }], // webhook delivery claim
			[], // workspace_credit_ledger claim — CONFLICT, already credited
		]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							credit_balance_cents: 3_500,
						},
					},
				},
			],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_credit_topup_replay',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_credit_1',
					mode: 'payment',
					client_reference_id: workspaceId,
					metadata: { workspace_id: workspaceId, kind: 'credit_topup', amount_usd_cents: '2500' },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)

		// Balance unchanged — not 6_000.
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({ credit_balance_cents: 3_500 })

		// And no duplicate audit event.
		const eventInsert = calls.inserts.find(
			(i) =>
				!!i &&
				typeof i === 'object' &&
				(i as Record<string, unknown>).action === 'workspace_credit_topup',
		)
		expect(eventInsert).toBeUndefined()
	})

	it('does not credit the balance when a credit_topup checkout carries an invalid amount', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		const workspaceId = randomUUID()
		mockResults.insertQueue = [[{ id: 'claim-topup-bad' }]]
		mockResults.select = STRIPE_SYSTEM_ACTOR
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: { billing: { plan: 'pro', status: 'active', credit_balance_cents: 1_000 } },
				},
			],
		]

		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_credit_topup_bad',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_credit_bad',
					mode: 'payment',
					client_reference_id: workspaceId,
					metadata: { workspace_id: workspaceId, kind: 'credit_topup', amount_usd_cents: '-1' },
				},
			},
		} as unknown as Stripe.Event)

		const res = await postWebhook(app, {})
		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({ credit_balance_cents: 1_000 })
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
