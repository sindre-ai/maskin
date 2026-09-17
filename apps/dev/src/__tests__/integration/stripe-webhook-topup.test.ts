import { randomUUID } from 'node:crypto'
import { webhookDeliveries, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: vi.fn(() => ({}) as unknown),
		verifyStripeWebhook: vi.fn(),
	}
})

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => {}),
}))

const { verifyStripeWebhook } = await import('../../lib/stripe')
const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
const { default: stripeWebhookRoutes } = await import('../../routes/stripe-webhook')

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_PRO: 'price_pro',
	STRIPE_PRICE_TEAM: 'price_team',
	MASKIN_PRO_HARD_CAP_USD_CENTS: '2000',
	MASKIN_TEAM_HARD_CAP_USD_CENTS: '20000',
	STRIPE_PRICE_LINKEDIN_IDENTITY: 'price_linkedin',
}

function post(app: { request: (req: Request) => Promise<Response> }) {
	return app.request(
		new Request('http://localhost/api/webhooks/stripe', {
			method: 'POST',
			headers: { 'stripe-signature': 't=1,v1=abc' },
			body: '{}',
		}),
	)
}

/**
 * End-to-end coverage of the credit-topup path against a real Postgres. The
 * mocked-DB unit tests pin the merge logic and the observability call surface;
 * this test proves the whole reconciliation guarantee against the same
 * migrations production runs — the ledger row, the balance bump, and the
 * partial-unique index that makes replay a no-op — under one workspace-row
 * lock. Any regression that breaks any of those in concert breaks Won (a)/(b)
 * / the retry-idempotency criterion at the bet's parent spec.
 */
describe('Stripe webhook — credit_topup integration', () => {
	let workspaceId: string
	let app: ReturnType<typeof createIntegrationApp>

	beforeEach(async () => {
		for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v
		vi.mocked(verifyStripeWebhook).mockReset()
		vi.mocked(capturePosthogEvent).mockClear()

		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				billing: {
					plan: 'pro',
					status: 'active',
					hard_cap_usd_cents: 2_000,
					period_start: 1_700_000_000,
					period_end: 1_702_592_000,
					stripe_customer_id: 'cus_topup_it',
					stripe_subscription_id: 'sub_topup_it',
					credit_balance_cents: 1_000,
				},
			},
		})
		workspaceId = ws.id
		app = createIntegrationApp({ path: '/api/webhooks/stripe', module: stripeWebhookRoutes })
	})

	afterEach(async () => {
		// The unique event.id lives across tests via webhook_deliveries; clean
		// per-test so retries in a re-run don't collide with the previous run's
		// claim row and short-circuit to duplicate=true.
		await sql`DELETE FROM webhook_deliveries WHERE workspace_id = ${workspaceId}`
		await sql`DELETE FROM workspace_credit_ledger WHERE workspace_id = ${workspaceId}`
	})

	function mockTopupEvent(sessionId: string, opts: { createdSec?: number; eventId?: string } = {}) {
		const nowSec = Math.floor(Date.now() / 1000)
		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: opts.eventId ?? `evt_topup_${sessionId}`,
			type: 'checkout.session.completed',
			data: {
				object: {
					id: sessionId,
					mode: 'payment',
					created: opts.createdSec ?? nowSec - 3,
					client_reference_id: workspaceId,
					customer: 'cus_topup_it',
					metadata: {
						workspace_id: workspaceId,
						kind: 'credit_topup',
						amount_usd_cents: '2500',
					},
				},
			},
		} as unknown as Stripe.Event)
	}

	it('atomically inserts the ledger row + bumps credit_balance_cents and fires credit_purchase_reconciled', async () => {
		const sessionId = `cs_topup_${randomUUID()}`
		mockTopupEvent(sessionId)

		const res = await post(app)
		expect(res.status).toBe(200)

		// Ledger row landed with the exact keys the reconciler + partial-unique
		// index rely on.
		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(
				and(
					eq(workspaceCreditLedger.workspaceId, workspaceId),
					eq(workspaceCreditLedger.stripeCheckoutSessionId, sessionId),
				),
			)
		expect(ledgerRows).toHaveLength(1)
		expect(ledgerRows[0]).toMatchObject({
			type: 'topup',
			amountCents: 2_500,
			balanceAfterCents: 3_500,
		})

		// Balance bumped in the same transaction — no half-applied state.
		const [wsRow] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
		const billing = (wsRow?.settings as { billing?: Record<string, unknown> })?.billing
		expect(billing).toMatchObject({ credit_balance_cents: 3_500 })

		// Observability fired exactly once, with all four required properties.
		const reconciled = vi
			.mocked(capturePosthogEvent)
			.mock.calls.filter(([event]) => event === 'credit_purchase_reconciled')
		expect(reconciled).toHaveLength(1)
		const reconciledCall = reconciled[0]
		if (!reconciledCall) throw new Error('unreachable — length asserted above')
		expect(reconciledCall[1]).toBe(workspaceId)
		expect(reconciledCall[2]).toMatchObject({
			workspace_id: workspaceId,
			amount_cents: 2_500,
			stripe_checkout_session_id: sessionId,
		})
		expect(reconciledCall[2].lag_seconds as number).toBeGreaterThanOrEqual(0)
		expect(reconciledCall[2].lag_seconds as number).toBeLessThanOrEqual(60)
		expect(
			vi
				.mocked(capturePosthogEvent)
				.mock.calls.filter(([event]) => event === 'credit_purchase_reconciliation_lag_over_60s'),
		).toHaveLength(0)
	})

	it('does not double-credit and does not double-fire PostHog on a webhook_deliveries replay', async () => {
		const sessionId = `cs_topup_${randomUUID()}`
		mockTopupEvent(sessionId)

		const first = await post(app)
		expect(first.status).toBe(200)

		vi.mocked(capturePosthogEvent).mockClear()

		// Redeliver the same event.id — the webhook_deliveries dedup path
		// short-circuits before applyEvent runs and neither the balance nor the
		// ledger row can move. The partial-unique index is defense in depth for
		// the fail-open / stale-claim replay path exercised in the next test.
		mockTopupEvent(sessionId)
		const replay = await post(app)
		expect(replay.status).toBe(200)
		const replayBody = await replay.json()
		expect(replayBody).toMatchObject({ duplicate: true })

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(
				and(
					eq(workspaceCreditLedger.workspaceId, workspaceId),
					eq(workspaceCreditLedger.stripeCheckoutSessionId, sessionId),
				),
			)
		expect(ledgerRows).toHaveLength(1)
		const [wsRow] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
		const billing = (wsRow?.settings as { billing?: Record<string, unknown> })?.billing
		expect(billing).toMatchObject({ credit_balance_cents: 3_500 })
		expect(vi.mocked(capturePosthogEvent)).not.toHaveBeenCalled()
	})

	it('does not double-credit when the same Checkout Session arrives under a new event.id (dedup-claim fail-open)', async () => {
		const sessionId = `cs_topup_${randomUUID()}`
		mockTopupEvent(sessionId, { eventId: 'evt_topup_first' })
		const first = await post(app)
		expect(first.status).toBe(200)

		vi.mocked(capturePosthogEvent).mockClear()

		// A new event.id means webhookDeliveries lets it through, but the
		// partial-unique index on `workspace_credit_ledger (stripe_checkout_session_id)`
		// must still block a second credit. PostHog must NOT fire on the
		// suppressed replay — the base event's `credit_purchase_reconciled`
		// count would otherwise inflate on every Stripe retry.
		mockTopupEvent(sessionId, { eventId: 'evt_topup_second' })
		const second = await post(app)
		expect(second.status).toBe(200)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(
				and(
					eq(workspaceCreditLedger.workspaceId, workspaceId),
					eq(workspaceCreditLedger.stripeCheckoutSessionId, sessionId),
				),
			)
		expect(ledgerRows).toHaveLength(1)
		const [wsRow] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
		const billing = (wsRow?.settings as { billing?: Record<string, unknown> })?.billing
		expect(billing).toMatchObject({ credit_balance_cents: 3_500 })
		expect(vi.mocked(capturePosthogEvent)).not.toHaveBeenCalled()

		// Both deliveries recorded — the second landed a webhook_deliveries
		// claim row of its own (fail-open path), so the dedup ledger alone did
		// not save us — the partial-unique index did.
		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, workspaceId))
		expect(claims).toHaveLength(2)
	})

	it('fires credit_purchase_reconciliation_lag_over_60s when Stripe session.created breaches the 60s SLO', async () => {
		const sessionId = `cs_topup_${randomUUID()}`
		mockTopupEvent(sessionId, { createdSec: Math.floor(Date.now() / 1000) - 120 })

		const res = await post(app)
		expect(res.status).toBe(200)

		const reconciled = vi
			.mocked(capturePosthogEvent)
			.mock.calls.filter(([event]) => event === 'credit_purchase_reconciled')
		const lagOver = vi
			.mocked(capturePosthogEvent)
			.mock.calls.filter(([event]) => event === 'credit_purchase_reconciliation_lag_over_60s')
		expect(reconciled).toHaveLength(1)
		expect(lagOver).toHaveLength(1)
		const reconciledCall = reconciled[0]
		const lagOverCall = lagOver[0]
		if (!reconciledCall || !lagOverCall) throw new Error('unreachable — length asserted above')
		expect(reconciledCall[2].lag_seconds as number).toBeGreaterThan(60)
		expect(lagOverCall[2]).toEqual(reconciledCall[2])
	})
})
