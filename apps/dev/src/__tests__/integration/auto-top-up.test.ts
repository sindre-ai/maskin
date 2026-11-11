import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, awaitingVies, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { creditedAmountUsdMinor, debitCreditForSession } from '../../lib/credit-billing'
import { createApiError, formatZodError } from '../../lib/errors'
import { FLAGS, _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { insertSession, insertWorkspace } from '../factories'
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

	it('charges once and credits the balance when it is under the threshold', async () => {
		await seed(400)
		await maybeAutoTopUp({ db, workspaceId, actorId })

		const settings = await readSettings()
		expect(settings.billing.credit_balance_cents).toBe(5_400)
		expect(settings.auto_top_up.in_flight).toBeUndefined()
		expect(settings.auto_top_up.last_charged_at).toBeTypeOf('number')
		// The write was a key write: nothing else in the blob moved.
		expect(settings.an_unmodelled_future_key).toEqual({ keep: 'me' })

		const rows = await topUpRows()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.stripeCheckoutSessionId).toBe('in_test_1')
		expect(rows[0]?.amountCents).toBe(5_000)
		expect(await eventActions()).toContain('workspace_auto_top_up_charged')
		expect(calls.filter((c) => c === 'invoices.pay')).toHaveLength(1)
	})

	it('does nothing while the balance is at or above the threshold', async () => {
		await seed(1_000)
		await maybeAutoTopUp({ db, workspaceId, actorId })
		expect(calls).toEqual([])
		expect((await readSettings()).billing.credit_balance_cents).toBe(1_000)
	})

	it('does nothing when the rule is off', async () => {
		await seed(0, { ...RULE, enabled: false })
		await maybeAutoTopUp({ db, workspaceId, actorId })
		expect(calls).toEqual([])
	})

	describe('with the trial-card-percent switch on (plans have no top-up)', () => {
		function switchOn() {
			process.env.FF_SIGNUP_FEATURES = FLAGS.TRIAL_CARD_PERCENT
			_resetFeatureFlagConfig()
			onTestFinished(() => {
				Reflect.deleteProperty(process.env, 'FF_SIGNUP_FEATURES')
				_resetFeatureFlagConfig()
			})
		}

		it('never charges, and leaves the saved rule exactly as it was', async () => {
			await seed(400)
			switchOn()
			await maybeAutoTopUp({ db, workspaceId, actorId })

			expect(calls).toEqual([])
			expect(await topUpRows()).toHaveLength(0)
			const settings = await readSettings()
			expect(settings.billing.credit_balance_cents).toBe(400)
			expect(settings.auto_top_up).toEqual(RULE)
		})

		it('charges as before once the switch is off again', async () => {
			await seed(400)
			switchOn()
			await maybeAutoTopUp({ db, workspaceId, actorId })
			expect(calls).toEqual([])

			Reflect.deleteProperty(process.env, 'FF_SIGNUP_FEATURES')
			_resetFeatureFlagConfig()
			await maybeAutoTopUp({ db, workspaceId, actorId })
			expect(calls.filter((c) => c === 'invoices.pay')).toHaveLength(1)
			expect((await readSettings()).billing.credit_balance_cents).toBe(5_400)
		})
	})

	it('fires once when several debits cross the threshold at the same time', async () => {
		await seed(100)
		await Promise.all([1, 2, 3, 4].map(() => maybeAutoTopUp({ db, workspaceId, actorId })))
		expect(calls.filter((c) => c === 'invoices.pay')).toHaveLength(1)
		expect(await topUpRows()).toHaveLength(1)
		expect((await readSettings()).billing.credit_balance_cents).toBe(5_100)
	})

	it('charges only after the debit has committed', async () => {
		await seed(1_001)
		// $10.50 of usage against a $10.00 cap: a 50 cent debit takes 1001 to 951,
		// under the 1000 threshold.
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd: '10.50',
			inputTokens: 0,
			outputTokens: 0,
			createdAt: new Date(PERIOD_START_SEC * 1000 + 1000),
		})
		if (!session) throw new Error('session insert failed')

		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: session.id,
			actorId,
			wsSettings: {
				billing: {
					plan: 'pro',
					status: 'active',
					hard_cap_usd_cents: CAP_CENTS,
					period_start: PERIOD_START_SEC,
					stripe_customer_id: 'cus_test',
					credit_balance_cents: 1_001,
				},
			} as never,
		})

		// The card was charged when the balance already held the committed debit
		// (1001 - 50 = 951), not before it and not inside its transaction.
		expect(balanceAtCharge).toBe(951)
		expect((await readSettings()).billing.credit_balance_cents).toBe(951 + 5_000)
		const order = calls.filter((c) => c.startsWith('invoices.') || c.startsWith('invoiceItems.'))
		expect(order).toEqual([
			'invoices.create',
			'invoiceItems.create:5000',
			'invoices.finalize',
			'invoices.pay',
		])
	})

	it('leaves the balance alone, shows a failed state and records an event when the card is declined', async () => {
		await seed(400)
		stripeMode = 'decline'
		await maybeAutoTopUp({ db, workspaceId, actorId })

		const settings = await readSettings()
		expect(settings.billing.credit_balance_cents).toBe(400)
		expect(settings.auto_top_up.status).toBe('failed')
		expect(settings.auto_top_up.failure_reason).toBe('card_declined')
		expect(settings.auto_top_up.in_flight).toBeUndefined()
		expect(await topUpRows()).toHaveLength(0)
		expect(calls).toContain('invoices.void')
		expect(await eventActions()).toContain('workspace_auto_top_up_failed')

		// A failed rule does not try again on the next debit.
		calls.length = 0
		await maybeAutoTopUp({ db, workspaceId, actorId })
		expect(calls).toEqual([])
	})

	it('fails the rule instead of charging again when the card is charged but the credit step errors', async () => {
		await seed(400)
		const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('db down'))
		const now = Date.now()
		await maybeAutoTopUp({ db, workspaceId, actorId, now })
		spy.mockRestore()

		const settings = await readSettings()
		expect(settings.billing.credit_balance_cents).toBe(400)
		expect(settings.auto_top_up.status).toBe('failed')
		expect(settings.auto_top_up.failure_reason).toBe('charge_error')
		expect(settings.auto_top_up.in_flight).toBeUndefined()
		expect(await topUpRows()).toHaveLength(0)
		const failed = (await db.select().from(events).where(eq(events.entityId, workspaceId))).find(
			(e) => e.action === 'workspace_auto_top_up_failed',
		)
		expect(JSON.stringify(failed?.data)).toContain('in_test_1')

		// Past the 10 minute claim timeout the card is still not charged again.
		calls.length = 0
		await maybeAutoTopUp({ db, workspaceId, actorId, now: now + 11 * 60_000 })
		expect(calls).toEqual([])
	})

	it('fails with no_payment_method when there is no saved card', async () => {
		await seed(400)
		defaultPaymentMethod = null
		await maybeAutoTopUp({ db, workspaceId, actorId })
		const settings = await readSettings()
		expect(settings.auto_top_up.failure_reason).toBe('no_payment_method')
		expect(calls.some((c) => c.startsWith('invoices.'))).toBe(false)
	})

	it('does not charge while a VAT number check is held for the workspace', async () => {
		await seed(400)
		await db.insert(awaitingVies).values({
			sessionId: 'cs_held',
			customerId: 'cus_test',
			kind: 'topup',
			currency: 'dkk',
			amountTotal: 34_900,
			workspaceId,
		})
		await maybeAutoTopUp({ db, workspaceId, actorId })

		const settings = await readSettings()
		expect(calls).toEqual([])
		expect(settings.billing.credit_balance_cents).toBe(400)
		// Skipped, not failed: the rule stays healthy and releases its claim.
		expect(settings.auto_top_up.status).toBeUndefined()
		expect(settings.auto_top_up.in_flight).toBeUndefined()
	})

	it('does not charge while Stripe reports a pending tax id on the customer', async () => {
		await seed(400)
		taxIdStatus = 'pending'
		await maybeAutoTopUp({ db, workspaceId, actorId })
		expect(calls.some((c) => c.startsWith('invoices.'))).toBe(false)
		expect((await readSettings()).billing.credit_balance_cents).toBe(400)
	})

	it('treats an abandoned claim as free after the timeout but not before', async () => {
		const now = Date.now()
		await seed(400, { ...RULE, in_flight: { token: 'old', at: now - 60_000 } })
		await maybeAutoTopUp({ db, workspaceId, actorId, now })
		expect(calls).toEqual([])

		await maybeAutoTopUp({ db, workspaceId, actorId, now: now + 11 * 60_000 })
		expect(calls).toContain('invoices.pay')
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

		it('does nothing when the charge path already credited the invoice', async () => {
			await seed(400)
			await maybeAutoTopUp({ db, workspaceId, actorId })
			expect((await readSettings()).billing.credit_balance_cents).toBe(5_400)

			await deliverPaidInvoice({ claim: 'whatever', amount_cents: '5000' }, 'in_test_1')

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

		it('saves the rule with an atomic key write and reads it back with approximate kroner', async () => {
			await seed(400, null)
			const app = makeApp()
			const put = await app.request(jsonRequest('PUT', '/api/billing/auto-top-up', RULE, headers()))
			expect(put.status).toBe(200)

			const got = await app.request(jsonGet('/api/billing/auto-top-up', headers()))
			const body = (await got.json()) as {
				auto_top_up: {
					amount_cents: number
					amount_dkk_approx: number
					threshold_dkk_approx: number
				}
			}
			expect(body.auto_top_up.amount_cents).toBe(5_000)
			// $50 = 349 DKK on the fixed reference; $10 = 70 DKK, rounded.
			expect(body.auto_top_up.amount_dkk_approx).toBe(349)
			expect(body.auto_top_up.threshold_dkk_approx).toBe(70)

			const settings = await readSettings()
			expect(settings.an_unmodelled_future_key).toEqual({ keep: 'me' })
			expect(settings.billing.credit_balance_cents).toBe(400)
			expect(await eventActions()).toContain('workspace_auto_top_up_updated')
		})

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

		it('clears a failed state when the rule is saved again, and keeps an in-flight claim', async () => {
			await seed(400, {
				...RULE,
				status: 'failed',
				failure_reason: 'card_declined',
				failed_at: 1,
				in_flight: { token: 't', at: Date.now() },
			})
			const app = makeApp()
			const put = await app.request(jsonRequest('PUT', '/api/billing/auto-top-up', RULE, headers()))
			expect(put.status).toBe(200)
			const settings = await readSettings()
			expect(settings.auto_top_up.status).toBe('ok')
			expect(settings.auto_top_up.failure_reason).toBeNull()
			expect(settings.auto_top_up.in_flight).toBeDefined()
		})

		describe('with the trial-card-percent switch on', () => {
			function switchOn() {
				process.env.FF_SIGNUP_FEATURES = FLAGS.TRIAL_CARD_PERCENT
				_resetFeatureFlagConfig()
				onTestFinished(() => {
					Reflect.deleteProperty(process.env, 'FF_SIGNUP_FEATURES')
					_resetFeatureFlagConfig()
				})
			}

			it('refuses to turn the rule on, with a plain reason, and writes nothing', async () => {
				await seed(400, null)
				switchOn()
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
				switchOn()
				const res = await makeApp().request(
					jsonRequest('PUT', '/api/billing/auto-top-up', { ...RULE, enabled: false }, headers()),
				)
				expect(res.status).toBe(200)
				expect((await readSettings()).auto_top_up).toMatchObject({ ...RULE, enabled: false })
			})
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
