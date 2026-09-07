import { OpenAPIHono } from '@hono/zod-openapi'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	webhookDeliveries,
	workspaceCreditLedger,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import { isEnterprise } from '../lib/enterprise'
import { createApiError } from '../lib/errors'

/**
 * Is this subscription the LinkedIn add-on's own, rather than the workspace
 * plan's? Two independent signals, either sufficient:
 *
 *   - its price is the configured add-on price, or
 *   - its id already matches the add-on subscription id we stored.
 *
 * Two, because each covers the other's blind spot. The price check fails if
 * `STRIPE_PRICE_LINKEDIN_IDENTITY` is rotated or unset in this environment;
 * the stored-id check fails on `customer.subscription.created`, which is the
 * first time we ever see the id. Getting this wrong in the false-negative
 * direction is the dangerous one: an add-on event treated as a plan event
 * rewrites the workspace's plan, cap and period.
 */
function isAddonSubscription(
	sub: { id: string; metadata?: Record<string, string> | null },
	priceId: string | null,
	billing: { linkedin_addon_subscription_id?: string | null },
	env: StripeEnv,
): boolean {
	if (sub.metadata?.kind === LINKEDIN_ADDON_METADATA_KIND) return true
	if (isLinkedInAddonPrice(priceId, env)) return true
	return Boolean(
		billing.linkedin_addon_subscription_id && billing.linkedin_addon_subscription_id === sub.id,
	)
}

import { billingAfterCancel, settingsAfterPaidPlanActivation } from '../lib/llm-source-mutex'
import { logger } from '../lib/logger'
import {
	CREDIT_TOPUP_METADATA_KIND,
	LINKEDIN_ADDON_METADATA_KIND,
	getStripeClient,
	hardCapForPlan,
	isHandledStripeEvent,
	isLinkedInAddonPrice,
	mapSubscriptionStatus,
	planForPriceId,
	priceIdFromSubscription,
	readStripeEnv,
	resolveWorkspaceIdFromEvent,
	verifyStripeWebhook,
} from '../lib/stripe'
import type { StripeEnv } from '../lib/stripe'

const STRIPE_SYSTEM_ACTOR_NAME = 'Stripe'

type Tx = Pick<Database, 'select' | 'insert'>

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
			.select({
				id: workspaces.id,
				settings: workspaces.settings,
				enterpriseGranted: workspaces.enterpriseGranted,
				billingOwnerId: workspaces.billingOwnerId,
			})
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
		// True once a branch has applied a subscription/invoice-shaped
		// mutation. The BYO-LLM mutex below keys off this rather than off
		// `status === 'active'`: a credit top-up on an already-active pro/team
		// workspace leaves `status` untouched at 'active', and stripping BYO
		// slots on that path silently wiped `claude_oauth` / `custom_llm` /
		// `llm_keys.anthropic` for the entitled workspaces that are allowed to
		// hold both (see lib/enterprise-allowlist.ts's `isEnterprise`).
		let planMutated = false

		switch (event.type) {
			case 'checkout.session.completed': {
				const session = event.data.object as Stripe.Checkout.Session
				if (session.mode === 'payment' && session.metadata?.kind === CREDIT_TOPUP_METADATA_KIND) {
					// Prepaid usage-credits top-up: money has already been captured
					// by Stripe — credit the balance unconditionally (eligibility
					// gates *spending* the balance later, not receiving money
					// already paid for). Reuses the row lock taken above; must NOT
					// touch plan/status/period_* — only `next.credit_balance_cents`
					// changes here, so this intentionally never falls into the
					// subscription-shaped mutation below.
					const amountCents = Number(
						session.metadata?.amount_usd_cents ?? session.amount_total ?? Number.NaN,
					)
					if (!Number.isFinite(amountCents) || amountCents <= 0) {
						logger.error('Credit top-up checkout.session.completed with invalid amount', {
							sessionId: session.id,
							workspaceId,
						})
						break
					}
					const currentBalance =
						typeof current.credit_balance_cents === 'number' && current.credit_balance_cents > 0
							? current.credit_balance_cents
							: 0
					const balanceAfter = currentBalance + amountCents

					// Claim the ledger row FIRST and only credit the balance if the
					// claim succeeded. The partial unique index on
					// `stripe_checkout_session_id` makes this insert the idempotency
					// gate for the *money*, not just for the audit row: applying the
					// balance delta before it meant a redelivered top-up credited the
					// customer twice while the ledger recorded one payment. Two live
					// replay paths reach here — the dedup-claim fail-open above, and a
					// failed `processed_at` mark that the reconciler releases — and
					// Stripe retries for ~3 days. Mirrors the debit side, which
					// likewise returns before mutating (lib/credit-billing.ts).
					const ledgerClaim = await tx
						.insert(workspaceCreditLedger)
						.values({
							workspaceId,
							type: 'topup',
							amountCents,
							balanceAfterCents: balanceAfter,
							stripeCheckoutSessionId: session.id,
						})
						.onConflictDoNothing({
							target: [workspaceCreditLedger.stripeCheckoutSessionId],
							where: sql`${workspaceCreditLedger.type} = 'topup' AND ${workspaceCreditLedger.stripeCheckoutSessionId} IS NOT NULL`,
						})
						.returning({ id: workspaceCreditLedger.id })

					if (!ledgerClaim[0]?.id) {
						// Already credited by an earlier delivery of this same checkout
						// session. Leave the balance untouched and fall through to the
						// unconditional settings write below, which is a no-op for
						// billing since `next` still equals `current` here.
						logger.warn('Credit top-up replay suppressed — balance already credited', {
							sessionId: session.id,
							workspaceId,
							amountCents,
						})
						break
					}

					next = { ...next, credit_balance_cents: balanceAfter }

					const systemActorId = await getOrCreateStripeSystemActor(tx, workspaceId)
					await tx.insert(events).values({
						workspaceId,
						actorId: systemActorId,
						action: 'workspace_credit_topup',
						entityType: 'workspace',
						entityId: workspaceId,
						data: {
							amount_cents: amountCents,
							balance_after_cents: balanceAfter,
							stripe_checkout_session_id: session.id,
						},
					})
					break
				}
				const subscriptionId =
					typeof session.subscription === 'string'
						? session.subscription
						: (session.subscription?.id ?? null)
				const customerId =
					typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null)
				if (session.metadata?.kind === LINKEDIN_ADDON_METADATA_KIND) {
					// The LinkedIn add-on's OWN subscription (trial workspaces, which
					// have no plan subscription to hang an item on). It must never
					// touch plan/status/period_* — writing `stripe_subscription_id`
					// here would make a $49 add-on look like the workspace's plan,
					// and `settingsAfterPaidPlanActivation` would then grant
					// maskin_plan LLM routing to a workspace that never bought it.
					next = {
						...next,
						stripe_customer_id: customerId ?? next.stripe_customer_id,
						linkedin_addon_subscription_id: subscriptionId ?? next.linkedin_addon_subscription_id,
					}
					break
				}
				// Clear stale period bounds so the billing route's fallback shows a
				// future reset time while we wait for customer.subscription.created to
				// arrive with the real Stripe period. Only clear when period_end is
				// already in the past — a future period_end means an out-of-order
				// customer.subscription.created already wrote real data and we must not
				// clobber it.
				const nowSec = Math.floor(Date.now() / 1000)
				const periodEndIsStale = typeof next.period_end === 'number' && next.period_end <= nowSec
				planMutated = true
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
				if (isAddonSubscription(sub, priceId, next, stripeEnv)) {
					// Add-on subscription, not the plan. Record its ids and stop:
					// falling through would set `plan` from a null lookup, reset
					// `hard_cap_usd_cents`, and overwrite the plan's period bounds
					// with the add-on's — silently changing what the workspace is
					// entitled to because it connected LinkedIn.
					next = {
						...next,
						linkedin_addon_subscription_id: sub.id,
						linkedin_addon_item_id: sub.items?.data?.[0]?.id ?? next.linkedin_addon_item_id,
					}
					break
				}
				const plan = priceId ? planForPriceId(priceId, stripeEnv) : null
				planMutated = true
				next = {
					...next,
					plan: plan ?? next.plan,
					stripe_customer_id:
						(typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null)) ??
						next.stripe_customer_id,
					stripe_subscription_id: sub.id,
					status: mapSubscriptionStatus(sub.status),
					hard_cap_usd_cents: plan ? hardCapForPlan(plan, stripeEnv) : next.hard_cap_usd_cents,
					period_start: sub.current_period_start ?? next.period_start,
					period_end: sub.current_period_end ?? next.period_end,
				}
				break
			}
			case 'customer.subscription.deleted': {
				const sub = event.data.object as Stripe.Subscription
				if (isAddonSubscription(sub, priceIdFromSubscription(sub), next, stripeEnv)) {
					// Cancelling the $49 add-on is not cancelling the plan. Without
					// this guard `billingAfterCancel` would run and drop a paying
					// workspace to trial (or enterprise) because it disconnected
					// its last LinkedIn identity.
					next = {
						...next,
						linkedin_addon_subscription_id: null,
						linkedin_addon_item_id: null,
					}
					break
				}
				planMutated = true
				// `plan: 'enterprise'` is NOT safe to write unconditionally here.
				// It sits at the top of PLAN_TIER_ORDER with null (unlimited)
				// seat and ownership caps, so an unentitled workspace could
				// cancel its subscription to self-grant unlimited seats and
				// unlimited workspace ownership - the exact circularity
				// `isEnterprise` documents. It also routes nowhere: 'enterprise'
				// is excluded from MASKIN_PLAN_ROUTED_PLANS, so a non-BYO
				// workspace landing there can start no sessions at all, with
				// no cap error and no upgrade CTA. `billingAfterCancel`
				// already encodes the right split (entitled -> enterprise,
				// everyone else -> trial), so this uses the same helper as
				// POST /api/billing/cancel.
				const canceled = billingAfterCancel(next, isEnterprise(workspace))
				next = {
					...(canceled ?? next),
					hard_cap_usd_cents: null,
					period_start: sub.canceled_at ?? next.period_start,
				}
				break
			}
			case 'invoice.paid': {
				const invoice = event.data.object as Stripe.Invoice
				const periodStart = invoice.period_start ?? invoice.lines?.data?.[0]?.period?.start
				const periodEnd = invoice.period_end ?? invoice.lines?.data?.[0]?.period?.end
				planMutated = true
				next = {
					...next,
					status: 'active',
					period_start: periodStart ?? next.period_start,
					period_end: periodEnd ?? next.period_end,
				}
				break
			}
			case 'invoice.payment_failed': {
				planMutated = true
				next = { ...next, status: 'past_due' }
				break
			}
		}

		// BYO-LLM -> paid plan mutex: when the subscription lands in an active
		// paid state, clear every BYO source in the same workspace update so we
		// never keep both sides "active" at once.
		const baseSettings = (workspace.settings ?? {}) as Record<string, unknown>
		const carrierSettings =
			planMutated && next.status === 'active'
				? settingsAfterPaidPlanActivation(baseSettings)
				: baseSettings
		const merged = { ...carrierSettings, billing: next }
		await tx
			.update(workspaces)
			.set({ settings: merged, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))

		// Audit + real-time. Without this row the subscription lifecycle is
		// invisible: no PG NOTIFY, so the billing UI keeps rendering the old
		// plan until something else refetches, and a disputed charge has no
		// who/when record. Mirrors the credit-topup branch above; skipped when
		// nothing plan-shaped changed (a top-up already wrote its own event).
		if (planMutated) {
			const systemActorId = await getOrCreateStripeSystemActor(tx, workspaceId)
			await tx.insert(events).values({
				workspaceId,
				actorId: systemActorId,
				action: 'workspace_billing_updated',
				entityType: 'workspace',
				entityId: workspaceId,
				data: {
					stripe_event_type: event.type,
					stripe_event_id: event.id,
					plan_before: current.plan ?? null,
					plan_after: next.plan ?? null,
					status_before: current.status ?? null,
					status_after: next.status ?? null,
				},
			})
		}
	})
}

/**
 * Get-or-create the shared "Stripe" system actor used to attribute
 * webhook-driven audit events, mirroring the pattern in
 * `routes/integrations.ts` (system actor per provider, ensured as a
 * workspace member so the events row's workspace-scoped reads resolve it).
 */
async function getOrCreateStripeSystemActor(tx: Tx, workspaceId: string): Promise<string> {
	let [systemActor] = await tx
		.select({ id: actors.id })
		.from(actors)
		.where(and(eq(actors.type, 'system'), eq(actors.name, STRIPE_SYSTEM_ACTOR_NAME)))
		.limit(1)

	if (!systemActor) {
		const [newActor] = await tx
			.insert(actors)
			.values({
				type: 'system',
				name: STRIPE_SYSTEM_ACTOR_NAME,
				apiKey: generateApiKey().key,
			})
			.returning({ id: actors.id })
		if (!newActor) {
			throw new Error('Failed to create Stripe system actor')
		}
		systemActor = newActor
	}

	const [existingMember] = await tx
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, systemActor.id),
			),
		)
		.limit(1)

	if (!existingMember) {
		await tx.insert(workspaceMembers).values({
			workspaceId,
			actorId: systemActor.id,
			role: 'system',
		})
	}

	return systemActor.id
}

export default app
