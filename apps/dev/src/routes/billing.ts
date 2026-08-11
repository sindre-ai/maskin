import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, billing as billingTable, invoices as invoicesTable } from '@maskin/db/schema'
import { desc, eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'
import {
	FLAT_PLAN,
	type ResolvedPlan,
	type StripeLike,
	getPublishableKey,
	getStripeClient,
	isTestMode,
	resolvePlan,
} from '../lib/stripe'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

export interface BillingDeps {
	/** Injectable Stripe client. Defaults to the env-configured client. */
	stripe?: StripeLike | null
	/** Injectable plan resolver. Defaults to env-configured STRIPE_PRICE_ID. */
	resolvePlan?: () => Promise<ResolvedPlan>
}

const planResponseSchema = z.object({
	planId: z.string(),
	planLabel: z.string().nullable(),
	status: z.string(),
	priceCents: z.number().nullable(),
	currency: z.string(),
	nextChargeAt: z.string().datetime().nullable(),
})

const invoiceResponseSchema = z.object({
	id: z.string().uuid(),
	description: z.string(),
	amountCents: z.number(),
	currency: z.string(),
	status: z.string(),
	billedAt: z.string().datetime(),
})

const summaryResponseSchema = z.object({
	configured: z.boolean(),
	testMode: z.boolean(),
	publishableKey: z.string().nullable(),
	plan: planResponseSchema,
	invoiceEmail: z.string().nullable(),
	invoices: z.array(invoiceResponseSchema),
})

const checkoutResponseSchema = z.object({
	clientSecret: z.string(),
	testMode: z.boolean(),
	plan: planResponseSchema,
})

const portalResponseSchema = z.object({
	url: z.string(),
})

// ── GET / ─────────────────────────────────────────────────────────────────
// Billing summary for the settings page: plan snapshot, invoice email, and the
// full invoice history. The publishable key is served here (never bundled in a
// VITE_ env) so Stripe Elements can mount. `configured` lets the frontend
// degrade to a "Stripe not configured" notice instead of a broken checkout.

const summaryRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['billing'],
	summary: 'Get billing summary for the workspace',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Billing summary',
			content: { 'application/json': { schema: summaryResponseSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const FREE_PLAN = {
	planId: 'free',
	planLabel: 'Free',
	status: 'inactive',
	priceCents: null,
	currency: 'usd',
	nextChargeAt: null,
} as const

export function createBillingApp(deps: BillingDeps = {}) {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

	const stripeClient = () => deps.stripe ?? getStripeClient()
	const planResolver = deps.resolvePlan ?? resolvePlan

	app.openapi(summaryRoute, (async (c) => {
		const db = c.get('db')
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const configured = stripeClient() !== null

		const [billingRow] = await db
			.select()
			.from(billingTable)
			.where(eq(billingTable.workspaceId, workspaceId))
			.limit(1)

		const invoiceRows = await db
			.select()
			.from(invoicesTable)
			.where(eq(invoicesTable.workspaceId, workspaceId))
			.orderBy(desc(invoicesTable.billedAt))

		const plan = billingRow
			? {
					planId: billingRow.planId,
					planLabel: billingRow.planLabel,
					status: billingRow.status,
					priceCents: billingRow.priceCents,
					currency: billingRow.currency,
					nextChargeAt: billingRow.nextChargeAt,
				}
			: FREE_PLAN

		const publishableKey = getPublishableKey()

		return c.json({
			configured,
			testMode: isTestMode(publishableKey),
			publishableKey,
			plan,
			invoiceEmail: billingRow?.invoiceEmail ?? null,
			invoices: serializeArray(invoiceRows),
		})
	}) as RouteHandler<typeof summaryRoute, Env>)

	// ── POST /checkout ─────────────────────────────────────────────────────────
	// Creates a fresh PaymentIntent (amount resolved from the Stripe Price) and
	// snapshots the plan on the billing row as 'pending'. The Payment Element
	// mounts client-side with the returned clientSecret + publishable key; card
	// data only ever lives inside Stripe's own frames. No Stripe Customer is
	// created here — the complete step persists one only after payment succeeds
	// (avoids orphan customers on abandoned checkouts).

	const checkoutRoute = createRoute({
		method: 'post',
		path: '/checkout',
		tags: ['billing'],
		summary: 'Start a checkout for the workspace plan',
		request: {
			headers: workspaceIdHeader,
			body: {
				content: {
					'application/json': {
						schema: z.object({
							invoiceEmail: z.string().email().optional(),
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Checkout started',
				content: { 'application/json': { schema: checkoutResponseSchema } },
			},
			400: {
				description: 'Stripe not configured or plan price unresolvable',
				content: { 'application/json': { schema: errorSchema } },
			},
			403: {
				description: 'Not a workspace member',
				content: { 'application/json': { schema: errorSchema } },
			},
		},
	})

	app.openapi(checkoutRoute, (async (c) => {
		const db = c.get('db')
		const actorId = c.get('actorId')
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { invoiceEmail } = c.req.valid('json')

		const stripe = stripeClient()
		if (!stripe) {
			return c.json(
				createApiError('BAD_REQUEST', 'Stripe is not configured for this instance'),
				400,
			)
		}

		const plan = await planResolver()
		if (!plan.priceId) {
			// A configured instance must never charge the FLAT_PLAN placeholder.
			return c.json(
				createApiError('BAD_REQUEST', 'No Stripe price configured (STRIPE_PRICE_ID)'),
				400,
			)
		}

		let created: Awaited<ReturnType<StripeLike['paymentIntents']['create']>>
		try {
			created = await stripe.paymentIntents.create({
				amount: plan.priceCents,
				currency: plan.currency,
				metadata: { workspace_id: workspaceId },
				automatic_payment_methods: { enabled: true },
			})
		} catch (err) {
			logger.error('Stripe PaymentIntent create failed', { workspaceId, error: String(err) })
			return c.json(
				createApiError('INTERNAL_ERROR', 'Failed to start checkout. Please try again.'),
				500,
			)
		}

		// Upsert the plan snapshot. A workspace that already has an active plan
		// stays active — an abandoned re-checkout must not demote it to 'pending'
		// or overwrite the live price snapshot. First-time checkouts snapshot the
		// new plan as 'pending' until completion. Preserve the existing
		// invoiceEmail across checkouts unless the caller supplied one.
		const [existingRow] = await db
			.select()
			.from(billingTable)
			.where(eq(billingTable.workspaceId, workspaceId))
			.limit(1)
		const alreadyActive = existingRow?.status === 'active'
		const billingValues = alreadyActive
			? {
					workspaceId,
					status: 'active' as const,
					...(invoiceEmail ? { invoiceEmail } : {}),
					updatedAt: new Date(),
				}
			: {
					workspaceId,
					planId: plan.planId,
					planLabel: plan.planLabel,
					status: 'pending' as const,
					priceCents: plan.priceCents,
					currency: plan.currency,
					stripePriceId: plan.priceId,
					...(invoiceEmail ? { invoiceEmail } : {}),
					updatedAt: new Date(),
				}
		const nextStatus = alreadyActive ? 'active' : 'pending'
		await db.insert(billingTable).values(billingValues).onConflictDoUpdate({
			target: billingTable.workspaceId,
			set: billingValues,
		})

		// Audit + real-time: the billing row transitioned to 'pending' (or stayed 'active').
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'billing',
			entityId: workspaceId,
			data: { status: nextStatus, planId: plan.planId, priceCents: plan.priceCents },
		})

		capturePosthogEvent('billing_checkout_started', workspaceId, {
			workspace_id: workspaceId,
			actor_id: actorId,
			amount_cents: plan.priceCents,
			currency: plan.currency,
		})

		return c.json({
			clientSecret: created.client_secret,
			testMode: isTestMode(getPublishableKey()),
			plan: {
				planId: plan.planId,
				planLabel: plan.planLabel,
				status: nextStatus,
				priceCents: plan.priceCents,
				currency: plan.currency,
				nextChargeAt: null,
			},
		})
	}) as RouteHandler<typeof checkoutRoute, Env>)

	// ── POST /complete ─────────────────────────────────────────────────────────
	// Verifies the PaymentIntent server-side (status === 'succeeded' AND metadata
	// workspace match) before marking the plan active — a client cannot fabricate
	// a successful payment. On decline, the billing row flips to 'declined' for
	// the UI to surface. Idempotent per payment intent: re-confirming the same
	// succeeded intent short-circuits instead of double-inserting an invoice.

	const completeRoute = createRoute({
		method: 'post',
		path: '/complete',
		tags: ['billing'],
		summary: 'Confirm a checkout after Stripe Elements completes',
		request: {
			headers: workspaceIdHeader,
			body: {
				content: {
					'application/json': {
						schema: z.object({
							paymentIntentId: z.string().min(1),
							invoiceEmail: z.string().email().optional(),
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'Payment verified and plan activated',
				content: { 'application/json': { schema: summaryResponseSchema } },
			},
			400: {
				description: 'Payment failed or belongs to another workspace',
				content: { 'application/json': { schema: errorSchema } },
			},
			403: {
				description: 'Not a workspace member',
				content: { 'application/json': { schema: errorSchema } },
			},
		},
	})

	app.openapi(completeRoute, (async (c) => {
		const db = c.get('db')
		const actorId = c.get('actorId')
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { paymentIntentId, invoiceEmail } = c.req.valid('json')

		const stripe = stripeClient()
		if (!stripe) {
			return c.json(
				createApiError('BAD_REQUEST', 'Stripe is not configured for this instance'),
				400,
			)
		}

		let intent: Awaited<ReturnType<StripeLike['paymentIntents']['retrieve']>>
		try {
			intent = await stripe.paymentIntents.retrieve(paymentIntentId)
		} catch {
			// One generic message for both "intent does not exist" and "intent
			// belongs to another workspace" — distinguishing them would let a
			// member probe arbitrary payment-intent ids.
			return c.json(createApiError('BAD_REQUEST', 'Unable to verify this payment'), 400)
		}

		if (intent.metadata.workspace_id !== workspaceId) {
			return c.json(createApiError('BAD_REQUEST', 'Unable to verify this payment'), 400)
		}

		if (intent.status !== 'succeeded') {
			// Mark declined so the UI can show the failure reason on the plan card.
			// An active plan must not be demoted by a failed change-plan re-pay --
			// the decline surfaces as the 400 response either way.
			const [declineRow] = await db
				.select()
				.from(billingTable)
				.where(eq(billingTable.workspaceId, workspaceId))
				.limit(1)

			if (declineRow?.status !== 'active') {
				await db
					.insert(billingTable)
					.values({ workspaceId, status: 'declined', updatedAt: new Date() })
					.onConflictDoUpdate({
						target: billingTable.workspaceId,
						set: { status: 'declined', updatedAt: new Date() },
					})

				await db.insert(events).values({
					workspaceId,
					actorId,
					action: 'updated',
					entityType: 'billing',
					entityId: workspaceId,
					data: { status: 'declined', paymentIntentId },
				})
			}

			capturePosthogEvent('billing_payment_declined', workspaceId, {
				workspace_id: workspaceId,
				actor_id: actorId,
				payment_intent_id: paymentIntentId,
			})

			return c.json(
				createApiError('BAD_REQUEST', 'Your payment was declined. Please try again.'),
				400,
			)
		}

		// Idempotency: the partial unique index on stripe_payment_intent_id
		// serializes concurrent re-confirms of the same intent — only the first
		// request inserts. Racing duplicates take the onConflictDoNothing no-op
		// path, skip the side effects below, and re-read the row the winner
		// wrote. The pre-check is gone on purpose: the index is the arbiter.
		const [billingRow] = await db
			.select()
			.from(billingTable)
			.where(eq(billingTable.workspaceId, workspaceId))
			.limit(1)

		const planLabel = billingRow?.planLabel ?? FLAT_PLAN.planLabel
		const [invoice] = await db
			.insert(invoicesTable)
			.values({
				workspaceId,
				description: `${planLabel} plan — monthly`,
				amountCents: intent.amount,
				currency: intent.currency,
				stripePaymentIntentId: intent.id,
				status: 'paid',
				billedAt: new Date(),
			})
			.onConflictDoNothing()
			.returning()

		if (invoice) {
			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'invoice',
				entityId: invoice.id,
				data: {
					description: invoice.description,
					amountCents: invoice.amountCents,
					currency: invoice.currency,
				},
			})

			capturePosthogEvent('billing_payment_succeeded', workspaceId, {
				workspace_id: workspaceId,
				actor_id: actorId,
				amount_cents: intent.amount,
				currency: intent.currency,
			})

			// Activate the plan (preserving invoice email, price + plan snapshot).
			// A Stripe Customer is created only now — after the payment succeeded —
			// so abandoned checkouts never leave orphan customers behind.
			// Best-effort: a customer-create failure must not block an
			// already-confirmed payment.
			let stripeCustomerId = billingRow?.stripeCustomerId ?? null
			if (!stripeCustomerId) {
				try {
					const customer = await stripe.customers.create({
						...(billingRow?.invoiceEmail ? { email: billingRow.invoiceEmail } : {}),
						metadata: { workspace_id: workspaceId },
					})
					stripeCustomerId = customer.id
				} catch (err) {
					logger.error('Stripe Customer create failed', { workspaceId, error: String(err) })
				}
			}

			const activateValues = {
				status: 'active' as const,
				planId: billingRow?.planId ?? FLAT_PLAN.planId,
				planLabel: billingRow?.planLabel ?? FLAT_PLAN.planLabel,
				priceCents: billingRow?.priceCents ?? intent.amount,
				currency: billingRow?.currency ?? intent.currency,
				stripePriceId: billingRow?.stripePriceId ?? null,
				stripeCustomerId,
				invoiceEmail: invoiceEmail ?? billingRow?.invoiceEmail ?? null,
				updatedAt: new Date(),
			}
			await db
				.insert(billingTable)
				.values({ workspaceId, ...activateValues })
				.onConflictDoUpdate({
					target: billingTable.workspaceId,
					set: activateValues,
				})

			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'billing',
				entityId: workspaceId,
				data: { status: 'active', paymentIntentId },
			})
		}

		// Build the response from the post-write row so a racing duplicate reads
		// the state the winner persisted (active plan, customer id, email).
		const [currentRow] = await db
			.select()
			.from(billingTable)
			.where(eq(billingTable.workspaceId, workspaceId))
			.limit(1)

		const invoiceRows = await db
			.select()
			.from(invoicesTable)
			.where(eq(invoicesTable.workspaceId, workspaceId))
			.orderBy(desc(invoicesTable.billedAt))

		const plan = currentRow
			? {
					planId: currentRow.planId,
					planLabel: currentRow.planLabel,
					status: 'active' as const,
					priceCents: currentRow.priceCents,
					currency: currentRow.currency,
					nextChargeAt: currentRow.nextChargeAt,
				}
			: FREE_PLAN

		return c.json({
			configured: true,
			testMode: isTestMode(getPublishableKey()),
			publishableKey: getPublishableKey(),
			plan,
			invoiceEmail: currentRow?.invoiceEmail ?? null,
			invoices: serializeArray(invoiceRows),
		})
	}) as RouteHandler<typeof completeRoute, Env>)

	// ── POST /portal ───────────────────────────────────────────────────────────
	// Creates a Stripe Customer Portal session ("Manage on Stripe"). Requires a
	// persisted Stripe Customer — created only after a successful payment — so
	// workspaces that never paid (or a Stripe-unconfigured instance) get a clear
	// 400 instead of a broken redirect.

	const portalRoute = createRoute({
		method: 'post',
		path: '/portal',
		tags: ['billing'],
		summary: 'Open the Stripe Customer Portal',
		request: {
			headers: workspaceIdHeader,
		},
		responses: {
			200: {
				description: 'Portal session URL',
				content: { 'application/json': { schema: portalResponseSchema } },
			},
			400: {
				description: 'Stripe not configured or no Stripe customer yet',
				content: { 'application/json': { schema: errorSchema } },
			},
			403: {
				description: 'Not a workspace member',
				content: { 'application/json': { schema: errorSchema } },
			},
		},
	})

	app.openapi(portalRoute, (async (c) => {
		const db = c.get('db')
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')

		const stripe = stripeClient()
		if (!stripe) {
			return c.json(
				createApiError('BAD_REQUEST', 'Stripe is not configured for this instance'),
				400,
			)
		}

		const [billingRow] = await db
			.select()
			.from(billingTable)
			.where(eq(billingTable.workspaceId, workspaceId))
			.limit(1)

		if (!billingRow?.stripeCustomerId) {
			return c.json(
				createApiError('BAD_REQUEST', 'Manage on Stripe is available once your plan is active'),
				400,
			)
		}

		const returnUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/${workspaceId}/settings/billing`
		let session: Awaited<ReturnType<StripeLike['billingPortal']['sessions']['create']>>
		try {
			session = await stripe.billingPortal.sessions.create({
				customer: billingRow.stripeCustomerId,
				return_url: returnUrl,
			})
		} catch (err) {
			logger.error('Stripe portal session create failed', {
				workspaceId,
				error: String(err),
			})
			return c.json(
				createApiError('INTERNAL_ERROR', 'Failed to open the Stripe portal. Please try again.'),
				500,
			)
		}

		return c.json({ url: session.url })
	}) as RouteHandler<typeof portalRoute, Env>)

	return app
}

export default createBillingApp()
