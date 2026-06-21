import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { webhookDeliveries, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
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
		// We can't link this back to a workspace. Acknowledge so Stripe stops
		// retrying - silent retries on orphaned events are noise, not a bug.
		logger.warn('Stripe webhook could not resolve workspace_id', {
			eventId: event.id,
			type: event.type,
		})
		return c.json({ ok: true, skipped: true, reason: 'no_workspace' })
	}

	// Claim BEFORE doing the workspace update. Without the claim, every Stripe
	// retry (and they retry aggressively on 5xx) would re-apply the same
	// state mutation. See packages/db/src/schema.ts:webhookDeliveries.
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
				target: [
					webhookDeliveries.provider,
					webhookDeliveries.externalId,
					webhookDeliveries.workspaceId,
				],
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
		// Fail open: the dedup ledger going down must not block real billing
		// updates. The reconciler will retry on the next event.
		logger.error('Failed to claim Stripe webhook delivery; processing without dedup', {
			eventId: event.id,
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	try {
		await applyEvent(db, workspaceId, event, stripeEnv)
		if (claimRowId) {
			// Mark the claim processed so the reconciler doesn't release it after the
			// 15m stale threshold. Without this, every successful Stripe delivery
			// would become re-processable within ~20m, but Stripe retries old events
			// for up to ~3 days - replaying a stale subscription.updated over current
			// state would regress the workspace (e.g. resurrect a canceled sub). If
			// the UPDATE itself fails we still ack the event: the work is done, the
			// dedup metadata is best-effort, and on-call has the log line.
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

	// Fallback: look up by stripe_customer_id stored on settings.billing.
	// Subscription / invoice events don't always carry metadata, but they
	// always carry `customer`. The JSONB path matches the partial expression
	// index `workspaces_billing_stripe_customer_id_idx` (migration 0026) so
	// this is a single indexable lookup per webhook delivery.
	const customerId = customerIdFromEvent(event)
	if (!customerId) return null

	const rows = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(sql`${workspaces.settings}->'billing'->>'stripe_customer_id' = ${customerId}`)
		.limit(1)
	return rows[0]?.id ?? null
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
	// Concurrent webhook deliveries on the same workspace each do a
	// SELECT -> mutate JSON -> UPDATE. Without serialization, a later writer
	// that read before an earlier writer's UPDATE silently clobbers fields
	// only the earlier writer touched. A row lock inside a transaction
	// serializes them on the workspace row; a single delivery still completes
	// in one round-trip per query so the lock window stays bounded.
	await db.transaction(async (tx) => {
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
				// Clear stale period bounds so the billing route's fallback shows a
				// future reset time while we wait for customer.subscription.created to
				// arrive with the real Stripe period. Only clear when period_end is
				// already in the past — a future period_end means an out-of-order
				// customer.subscription.created already wrote real data and we must not
				// clobber it.
				const nowSec = Math.floor(Date.now() / 1000)
				const periodEndIsStale = typeof next.period_end === 'number' && next.period_end <= nowSec
				next = {
					...next,
					stripe_customer_id: customerId ?? next.stripe_customer_id,
					stripe_subscription_id: subscriptionId ?? next.stripe_subscription_id,
					status: 'active',
					...(periodEndIsStale ? { period_start: null, period_end: null } : {}),
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
					period_end: sub.current_period_end ?? next.period_end,
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
				const periodEnd = invoice.period_end ?? invoice.lines?.data?.[0]?.period?.end
				next = {
					...next,
					status: 'active',
					period_start: periodStart ?? next.period_start,
					period_end: periodEnd ?? next.period_end,
				}
				break
			}
			case 'invoice.payment_failed': {
				next = { ...next, status: 'past_due' }
				break
			}
		}

		// BYOLLM -> paid plan mutex: when the subscription lands in an active
		// paid state, clear every BYO source in the same workspace update so we
		// never keep both sides "active" at once.
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
