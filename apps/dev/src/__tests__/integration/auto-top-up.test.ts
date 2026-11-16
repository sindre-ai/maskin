import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creditedAmountUsdMinor } from '../../lib/credit-billing'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// Stripe is replaced by an in-process stand-in that records every call in
// order. It proves OUR logic (claim, ordering against the debit, failure
// state, VAT hold, atomic key writes) against real Postgres. It is not
// evidence about how Stripe behaves: that needs a test-mode run (see the PR).
const calls: string[] = []
let stripeMode: 'pay' | 'decline' = 'pay'
let taxIdStatus: 'verified' | 'pending' = 'verified'
// What the workspace looked like when the card was charged.
let balanceAtCharge: number | null = null
let defaultPaymentMethod: string | null = 'pm_test'
let currentWorkspaceId = ''

const fakeStripe = {
	customers: {
		retrieve: async () => {
			calls.push('customers.retrieve')
			return {
				id: 'cus_test',
				currency: 'usd',
				invoice_settings: { default_payment_method: defaultPaymentMethod },
			}
		},
		listTaxIds: async () => {
			calls.push('customers.listTaxIds')
			return { data: [{ verification: { status: taxIdStatus } }] }
		},
	},
	paymentMethods: { list: async () => ({ data: [] }) },
	subscriptions: { retrieve: async () => ({ default_payment_method: null }) },
	prices: { retrieve: async () => ({ product: 'prod_credits' }) },
	invoices: {
		create: async (params: Record<string, unknown>) => {
			calls.push('invoices.create')
			expect(params.automatic_tax).toEqual({ enabled: true })
			// The paid-invoice webhook needs these to credit a charge the process never credited.
			expect(params.metadata).toMatchObject({
				workspace_id: currentWorkspaceId,
				kind: 'auto_top_up',
				amount_cents: '5000',
			})
			return { id: 'in_test_1' }
		},
		finalizeInvoice: async () => {
			calls.push('invoices.finalize')
			return { id: 'in_test_1' }
		},
		pay: async () => {
			calls.push('invoices.pay')
			const [row] = await db
				.select({ settings: workspaces.settings })
				.from(workspaces)
				.where(eq(workspaces.id, currentWorkspaceId))
			balanceAtCharge = (row?.settings as { billing?: { credit_balance_cents?: number } })?.billing
				?.credit_balance_cents as number
			if (stripeMode === 'decline') {
				throw new Stripe.errors.StripeCardError({
					type: 'card_error',
					code: 'card_declined',
					decline_code: 'generic_decline',
					message: 'Your card was declined.',
				} as never)
			}
			return { id: 'in_test_1', status: 'paid' }
		},
		retrieve: async () => ({ id: 'in_test_1', status: 'open' }),
		voidInvoice: async () => {
			calls.push('invoices.void')
			return {}
		},
		del: async () => {
			calls.push('invoices.del')
			return {}
		},
	},
	invoiceItems: {
		create: async (params: { price_data: { unit_amount: number } }) => {
			calls.push(`invoiceItems.create:${params.price_data.unit_amount}`)
			return { id: 'ii_test' }
		},
	},
}

vi.mock('../../lib/stripe', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/stripe')>()),
	getStripeClient: () => fakeStripe,
	// Signature checking is Stripe's code, not what the webhook tests are about:
	// the raw body is the event.
	verifyStripeWebhook: (_stripe: unknown, raw: string) => JSON.parse(raw),
}))

const { maybeAutoTopUp } = await import('../../lib/auto-top-up')
const { default: billingRoutes } = await import('../../routes/billing')
const { default: stripeWebhookRoutes } = await import('../../routes/stripe-webhook')

const PERIOD_START_SEC = 1_700_000_000
const CAP_CENTS = 1_000
const RULE = { enabled: true, threshold_cents: 1_000, amount_cents: 5_000 }

type Settings = {
	billing: { credit_balance_cents: number }
	auto_top_up: Record<string, unknown> & { status?: string; in_flight?: unknown }
	[k: string]: unknown
}

describe('auto top-up (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(() => {
		actorId = getTestActorId()
		calls.length = 0
		stripeMode = 'pay'
		taxIdStatus = 'verified'
		balanceAtCharge = null
		defaultPaymentMethod = 'pm_test'
		process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
		process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake'
		process.env.STRIPE_PRICE_PRO = 'price_pro'
		process.env.STRIPE_PRICE_TEAM = 'price_team'
		process.env.STRIPE_PRICE_CREDITS_CUSTOM = 'price_credits'
	})

	afterEach(() => {
		for (const k of [
			'STRIPE_SECRET_KEY',
			'STRIPE_WEBHOOK_SECRET',
			'STRIPE_PRICE_PRO',
			'STRIPE_PRICE_TEAM',
			'STRIPE_PRICE_CREDITS_CUSTOM',
		]) {
			delete process.env[k]
		}
	})

	async function seed(balance: number, rule: Record<string, unknown> | null = RULE) {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: {
				billing: {
					plan: 'pro',
					status: 'active',
					hard_cap_usd_cents: CAP_CENTS,
					period_start: PERIOD_START_SEC,
					stripe_customer_id: 'cus_test',
					credit_balance_cents: balance,
				},
				an_unmodelled_future_key: { keep: 'me' },
				...(rule ? { auto_top_up: rule } : {}),
			},
		})
		if (!ws) throw new Error('workspace insert failed')
		workspaceId = ws.id
		currentWorkspaceId = ws.id
		return ws
	}

	async function readSettings(): Promise<Settings> {
		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!row) throw new Error('workspace not found')
		return row.settings as Settings
	}

	const topUpRows = () =>
		db
			.select()
			.from(workspaceCreditLedger)
			.where(
				and(
					eq(workspaceCreditLedger.workspaceId, workspaceId),
					eq(workspaceCreditLedger.type, 'topup'),
				),
			)

	const eventActions = async () =>
		(await db.select().from(events).where(eq(events.entityId, workspaceId))).map((e) => e.action)

	it('never charges a plan workspace, and leaves the saved rule exactly as it was', async () => {
		await seed(400)
		await maybeAutoTopUp({ db, workspaceId, actorId })

		expect(calls).toEqual([])
		expect(await topUpRows()).toHaveLength(0)
		const settings = await readSettings()
		expect(settings.billing.credit_balance_cents).toBe(400)
		expect(settings.auto_top_up).toEqual(RULE)
	})

	it('keeps a single charge below the $250 bonus tier', () => {
		// The largest amount the rule accepts earns no volume bonus.
		expect(creditedAmountUsdMinor(24_900, 'usd')).toBe(24_900)
		expect(creditedAmountUsdMinor(86_900, 'dkk')).toBeLessThan(25_000)
	})

	describe('paid-invoice webhook (charged, but the process died before the credit)', () => {
		type Env = { Variables: { db: Database } }
		let eventSeq = 0
		function webhookApp() {
			const app = new OpenAPIHono<Env>()
			app.use('*', async (c, next) => {
				c.set('db', db)
				await next()
			})
			app.route('/api/webhooks/stripe', stripeWebhookRoutes as never)
			return app
		}
		async function deliverPaidInvoice(
			metadata: Record<string, string>,
			invoiceId = 'in_crashed_1',
		) {
			eventSeq += 1
			const body = JSON.stringify({
				id: `evt_paid_${workspaceId}_${eventSeq}`,
				type: 'invoice.paid',
				data: {
					object: {
						id: invoiceId,
						customer: 'cus_test',
						period_start: 111,
						period_end: 222,
						metadata: { workspace_id: workspaceId, kind: 'auto_top_up', ...metadata },
					},
				},
			})
			return webhookApp().request('/api/webhooks/stripe', {
				method: 'POST',
				headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
				body,
			})
		}
		// The state a crash leaves behind: card charged, claim still held, balance not credited.
		const crashed = { token: 'claim-1', at: Date.now() }

		it('credits the balance once, clears the claim, and leaves the plan alone', async () => {
			await seed(400, { ...RULE, in_flight: crashed })
			const res = await deliverPaidInvoice({ claim: 'claim-1', amount_cents: '5000' })
			expect(res.status).toBe(200)

			const settings = await readSettings()
			expect(settings.billing.credit_balance_cents).toBe(5_400)
			expect(settings.auto_top_up.in_flight).toBeUndefined()
			expect(settings.auto_top_up.last_charged_at).toBeTypeOf('number')
			expect(settings.auto_top_up.status ?? 'ok').toBe('ok')
			// A top-up invoice is not a plan invoice: period and status stay as they were.
			expect(settings.billing).toMatchObject({
				plan: 'pro',
				status: 'active',
				period_start: PERIOD_START_SEC,
			})
			expect(settings.an_unmodelled_future_key).toEqual({ keep: 'me' })

			const rows = await topUpRows()
			expect(rows).toHaveLength(1)
			expect(rows[0]?.stripeCheckoutSessionId).toBe('in_crashed_1')
			expect(await eventActions()).toContain('workspace_auto_top_up_charged')

			// The next debit does not charge the card again: the balance is back over the threshold.
			await maybeAutoTopUp({ db, workspaceId, actorId, now: Date.now() + 11 * 60_000 })
			expect(calls).toEqual([])
		})

		it('credits once when Stripe delivers the same paid invoice in a second event', async () => {
			await seed(400, { ...RULE, in_flight: crashed })
			await deliverPaidInvoice({ claim: 'claim-1', amount_cents: '5000' })
			await deliverPaidInvoice({ claim: 'claim-1', amount_cents: '5000' })

			expect((await readSettings()).billing.credit_balance_cents).toBe(5_400)
			expect(await topUpRows()).toHaveLength(1)
		})

		it('leaves a newer claim in place when the paid invoice belongs to an older one', async () => {
			await seed(400, { ...RULE, in_flight: { token: 'claim-2', at: Date.now() } })
			await deliverPaidInvoice({ claim: 'claim-1', amount_cents: '5000' })

			const settings = await readSettings()
			expect(settings.billing.credit_balance_cents).toBe(5_400)
			expect(settings.auto_top_up.in_flight).toMatchObject({ token: 'claim-2' })
		})

		it('credits a workspace whose rule has since been removed without wiping its settings', async () => {
			await seed(400, null)
			await deliverPaidInvoice({ claim: 'claim-1', amount_cents: '5000' })

			const settings = await readSettings()
			expect(settings.billing.credit_balance_cents).toBe(5_400)
			expect(settings.an_unmodelled_future_key).toEqual({ keep: 'me' })
		})

		it('credits nothing, and does not touch the plan period, when the amount is missing', async () => {
			await seed(400, { ...RULE, in_flight: crashed })
			const res = await deliverPaidInvoice({ claim: 'claim-1' })
			expect(res.status).toBe(200)

			const settings = await readSettings()
			expect(settings.billing.credit_balance_cents).toBe(400)
			expect(settings.billing).toMatchObject({ period_start: PERIOD_START_SEC })
			expect(await topUpRows()).toHaveLength(0)
		})
	})

	describe('routes', () => {
		type Env = { Variables: { db: Database; actorId: string; actorType: string } }
		function makeApp() {
			const app = new OpenAPIHono<Env>({
				defaultHook: (result, c) => {
					if (!result.success) {
						return c.json(
							createApiError(
								'VALIDATION_ERROR',
								'Request validation failed',
								formatZodError(result.error),
							),
							400,
						)
					}
					return undefined
				},
			})
			app.use('*', async (c, next) => {
				c.set('db', db)
				c.set('actorId', actorId)
				c.set('actorType', 'human')
				await next()
			})
			app.route('/api/billing', billingRoutes as never)
			return app
		}
		const headers = () => ({ 'X-Workspace-Id': workspaceId })

		it('rejects an amount at or above the $250 bonus tier and an amount under the threshold', async () => {
			await seed(400, null)
			const app = makeApp()
			const tooBig = await app.request(
				jsonRequest(
					'PUT',
					'/api/billing/auto-top-up',
					{ ...RULE, amount_cents: 25_000 },
					headers(),
				),
			)
			expect(tooBig.status).toBe(400)
			const underThreshold = await app.request(
				jsonRequest(
					'PUT',
					'/api/billing/auto-top-up',
					{ ...RULE, threshold_cents: 5_000, amount_cents: 3_000 },
					headers(),
				),
			)
			expect(underThreshold.status).toBe(400)
		})

		it('refuses to turn the rule on, with a plain reason, and writes nothing', async () => {
			await seed(400, null)
			const res = await makeApp().request(
				jsonRequest('PUT', '/api/billing/auto-top-up', RULE, headers()),
			)
			expect(res.status).toBe(400)
			const body = (await res.json()) as { error: { message: string } }
			expect(body.error.message).toContain('not available on a plan')
			expect((await readSettings()).auto_top_up).toBeUndefined()
			expect(await eventActions()).not.toContain('workspace_auto_top_up_updated')
		})

		it('still lets a saved rule be turned off, and keeps it', async () => {
			await seed(400)
			const res = await makeApp().request(
				jsonRequest('PUT', '/api/billing/auto-top-up', { ...RULE, enabled: false }, headers()),
			)
			expect(res.status).toBe(200)
			expect((await readSettings()).auto_top_up).toMatchObject({ ...RULE, enabled: false })
		})

		it('refuses to turn it on for a workspace with no Stripe customer', async () => {
			const ws = await insertWorkspace(db, actorId, {
				enterpriseGranted: false,
				settings: { billing: { plan: 'trial', status: 'active' } },
			})
			workspaceId = ws.id
			const res = await makeApp().request(
				jsonRequest('PUT', '/api/billing/auto-top-up', RULE, headers()),
			)
			expect(res.status).toBe(400)
		})
	})
})
