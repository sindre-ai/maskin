import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { webhookDeliveries, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { createApiError } from '../lib/errors'
import { settingsAfterPaidPlanActivation } from '../lib/llm-source-mutex'
import { logger } from '../lib/logger'
import {
	getStripeClient,
	hardCapForPlan,
	isHandledStripeEvent,
	mapSubscriptionStatus,
	planForPriceId,
	priceIdFromSubscription,
	readStripeEnv,
	resolveWorkspaceIdFromEvent,
	verifyStripeWebhook,
} from '../lib/stripe'
import type { StripeEnv } from '../lib/stripe'

type Env = {
	Variables: {
		db: Database
	}
}

const app = new OpenAPIHono<Env>()

const PROVIDER = 'stripe'

app.post('/', async (c) => {
	let stripeEnv: StripeEnv
	try {
		stripeEnv = readStripeEnv()
	} catch (err) {
		logger.error('Stripe webhook received but Stripe env not configured', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}

	const rawBody = await c.req.text()
	const signature = c.req.header('stripe-signature')
	if (!signature) {
		logger.warn('Stripe webhook missing signature header')
		return c.json(createApiError('UNAUTHORIZED', 'Missing stripe-signature header'), 401)
	}

	const stripe = getStripeClient(stripeEnv)
	let event: Stripe.Event
	try {
		event = verifyStripeWebhook(stripe, rawBody, signature, stripeEnv.webhookSecret)
	} catch (err) {
		logger.warn('Stripe webhook signature verification failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	if (!isHandledStripeEvent(event.type)) {
		logger.info('Stripe webhook event type not handled', {
			eventId: event.id,
			type: event.type,
		})
		return c.json({ ok: true, skipped: true, reason: 'unhandled_event_type' })
	}

	const workspaceId = await resolveWorkspaceId(c.get('db'), event)
	if (!workspaceId) {
		logger.warn('Stripe webhook could not resolve workspace_id', {
			eventId: event.id,
			type: event.type,
		})
		return c.json({ ok: true, skipped: true, reason: 'no_workspace' })
	}

	const db = c.get('db')
	let claimRowId: string | null = null
	try {
		const rows = await db
			.insert(webhookDeliveries)
			.values({
				provider: PROVIDER,
				externalId: event.id,
				workspaceId,
			})
			.onConflictDoNothing({
				target: [webhookDeliveries.provider, webhookDeliveries.externalId, webhookDeliveries.workspaceId],
			})
			.returning({ id: webhookDeliveries.id })
		if (rows.length === 0) {
			logger.info('Stripe webhook duplicate event ignored', {
				eventId: event.id,
				workspaceId,
				type: event.type,
			})
			return c.json({ ok: true, duplicate: true })
		}
		claimRowId = rows[0]?.id ?? null
	} catch (err) {
		logger.error('Failed to claim Stripe webhook delivery; processing without dedup', {
			eventId: event.id,
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	try {
		await applyEvent(db, workspaceId, event, stripeEnv)
		if (claimRowId) {
			try {
				await db
					.update(webhookDeliveries)
					.set({ processedAt: new Date() })
					.where(eq(webhookDeliveries.id, claimRowId))
			} catch (markErr) {
				logger.error(
					'Failed to mark Stripe webhook delivery as processed; reconciler may release the claim prematurely',
					{
						eventId: event.id,
						workspaceId,
						claimRowId,
						error: markErr instanceof Error ? markErr.message : String(markErr),
					},
				)
			}
		}
		logger.info('Stripe webhook applied', {
			eventId: event.id,
			workspaceId,
			type: event.type,
		})
		return c.json({ ok: true })
	} catch (err) {
		logger.error('Stripe webhook handler failed', {
			eventId: event.id,
			workspaceId,
			type: event.type,
			error: err instanceof Error ? err.message : String(err),
		})
		if (claimRowId) {
			try {
				await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, claimRowId))
			} catch (releaseErr) {
				logger.error('Failed to release Stripe webhook claim after handler failure', {
					eventId: event.id,
					workspaceId,
					error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
				})
			}
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to apply webhook'), 500)
	}
})

async function resolveWorkspaceId(db: Database, event: Stripe.Event): Promise<string | null> {
	const direct = resolveWorkspaceIdFromEvent(event)
	if (direct) return direct

	const customerId = customerIdFromEvent(event)
	if (!customerId) return null

	const rows = await db.select({ id: workspaces.id, settings: workspaces.settings }).from(workspaces)
	for (const row of rows) {
		const parsed = workspaceSettingsSchema.partial().safeParse(row.settings ?? {})
		if (parsed.success && parsed.data.billing?.stripe_customer_id === customerId) {
			return row.id
		}
	}
	return null
}

function customerIdFromEvent(event: Stripe.Event): string | null {
	const obj = event.data.object as { customer?: string | { id: string } | null }
	if (!obj.customer) return null
	if (typeof obj.customer === 'string') return obj.customer
	return obj.customer.id ?? null
}

async function applyEvent(
	db: Database,
	workspaceId: string,
	event: Stripe.Event,
	stripeEnv: StripeEnv,
): Promise<void> {
	await db.transaction(async (tx) => {
		// Row lock so concurrent writers can't interleave a read-modify-write
		// cycle and accidentally merge stale settings back over a newer update.
		const [workspace] = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!workspace) {
			throw new Error(`workspace ${workspaceId} not found while applying ${event.type}`)
		}

		const currentSettings =
			workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {}).data ?? {}
		const current = currentSettings.billing ?? {
			plan: 'trial' as const,
			status: 'incomplete' as const,
		}
		let next = { ...current }

		switch (event.type) {
			case 'checkout.session.completed': {
				const session = event.data.object as Stripe.Checkout.Session
				const subscriptionId =
					typeof session.subscription === 'string'
						? session.subscription
						: (session.subscription?.id ?? null)
				const customerId =
					typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null)
				next = {
					...next,
					stripe_customer_id: customerId ?? next.stripe_customer_id,
					stripe_subscription_id: subscriptionId ?? next.stripe_subscription_id,
					status: 'active',
				}
				break
			}
			case 'customer.subscription.created':
			case 'customer.subscription.updated': {
				const sub = event.data.object as Stripe.Subscription
				const priceId = priceIdFromSubscription(sub)
				const plan = priceId ? planForPriceId(priceId, stripeEnv) : null
				next = {
					...next,
					plan: plan ?? next.plan,
					stripe_customer_id:
						(typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null)) ??
						next.stripe_customer_id,
					stripe_subscription_id: sub.id,
					status: mapSubscriptionStatus(sub.status),
					hard_cap_tokens: plan ? hardCapForPlan(plan, stripeEnv) : next.hard_cap_tokens,
					period_start: sub.current_period_start ?? next.period_start,
				}
				break
			}
			case 'customer.subscription.deleted': {
				const sub = event.data.object as Stripe.Subscription
				next = {
					...next,
					plan: 'byollm',
					stripe_subscription_id: null,
					status: 'canceled',
					hard_cap_tokens: null,
					period_start: sub.canceled_at ?? next.period_start,
				}
				break
			}
			case 'invoice.paid': {
				const invoice = event.data.object as Stripe.Invoice
				const periodStart = invoice.period_start ?? invoice.lines?.data?.[0]?.period?.start
				next = {
					...next,
					status: 'active',
					period_start: periodStart ?? next.period_start,
				}
				break
			}
			case 'invoice.payment_failed': {
				next = { ...next, status: 'past_due' }
				break
			}
		}

		// BYOLLM ↔ paid plan mutex: when this event leaves the workspace in an
		// active paid state, drop every BYOLLM source in the same update.
		const baseSettings = (workspace.settings ?? {}) as Record<string, unknown>
		const carrierSettings =
			next.status === 'active' ? settingsAfterPaidPlanActivation(baseSettings) : baseSettings
		const merged = { ...carrierSettings, billing: next }

		await tx
			.update(workspaces)
			.set({ settings: merged, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))
	})
}

export default app
