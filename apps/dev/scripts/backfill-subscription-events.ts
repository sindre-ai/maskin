// One-shot backfill for PostHog billing events.
//
// The `subscription_started` / `subscription_canceled` / `subscription_past_due`
// PostHog emits were added to the Stripe webhook on 2026-06-29. The bet's
// `live_started_at` was 2026-06-22, so any subscription lifecycle event in the
// intervening week never made it to PostHog. This script walks the Stripe
// account and emits backdated events so the bet's ship-metric query covers
// the full live window.
//
// Idempotency: re-running double-emits. Each invocation is meant to be one-
// shot. PostHog can dedupe in HogQL via `min(timestamp) by stripe_subscription_id`.
//
// Run from the repo root:
//   POSTHOG_API_KEY=... STRIPE_SECRET_KEY=sk_live_... \
//   STRIPE_PRICE_STARTER=price_... STRIPE_PRICE_PRO=price_... \
//   MASKIN_STARTER_HARD_CAP_TOKENS=32000000 \
//   MASKIN_PRO_HARD_CAP_TOKENS=96000000 \
//   STRIPE_WEBHOOK_SECRET=whsec_dummy \
//   pnpm --filter @maskin/dev exec tsx scripts/backfill-subscription-events.ts
//
// `STRIPE_WEBHOOK_SECRET` is unused here but is required by `readStripeEnv`,
// which validates all Stripe vars up-front to fail loudly on misconfiguration.

import type Stripe from 'stripe'
import { emitBillingEvent } from '../src/lib/analytics/billing-events'
import {
	getStripeClient,
	planForPriceId,
	priceIdFromSubscription,
	readStripeEnv,
} from '../src/lib/stripe'

const CUTOFF = new Date('2026-06-22T00:00:00.000Z')

type Counters = {
	scanned: number
	skippedNoWorkspace: number
	skippedNoPaidPlan: number
	skippedNoSubId: number
	emittedStarted: number
	emittedCanceled: number
	emittedPastDue: number
}

function workspaceIdFromSubscription(sub: Stripe.Subscription): string | null {
	const fromSub = sub.metadata?.workspace_id
	if (typeof fromSub === 'string' && fromSub) return fromSub
	const customer = sub.customer
	if (customer && typeof customer !== 'string') {
		// `customer` was expanded; check its metadata too. The checkout flow
		// mirrors workspace_id onto both sides for exactly this fallback.
		const fromCustomer = (customer as Stripe.Customer).metadata?.workspace_id
		if (typeof fromCustomer === 'string' && fromCustomer) return fromCustomer
	}
	return null
}

async function processSubscription(
	sub: Stripe.Subscription,
	stripeEnv: ReturnType<typeof readStripeEnv>,
	counters: Counters,
): Promise<void> {
	counters.scanned += 1
	const workspaceId = workspaceIdFromSubscription(sub)
	if (!workspaceId) {
		counters.skippedNoWorkspace += 1
		return
	}
	const priceId = priceIdFromSubscription(sub)
	const plan = priceId ? planForPriceId(priceId, stripeEnv) : null
	if (plan !== 'starter' && plan !== 'pro') {
		counters.skippedNoPaidPlan += 1
		return
	}
	if (!sub.id) {
		counters.skippedNoSubId += 1
		return
	}

	const createdAt = new Date(sub.created * 1000)
	if (createdAt >= CUTOFF) {
		await emitBillingEvent(
			workspaceId,
			{ event: 'subscription_started', plan, stripeSubscriptionId: sub.id },
			{ timestamp: createdAt },
		)
		counters.emittedStarted += 1
	}

	if (sub.status === 'canceled') {
		const canceledAtSec = sub.canceled_at ?? sub.ended_at
		const canceledAt = canceledAtSec ? new Date(canceledAtSec * 1000) : null
		if (canceledAt && canceledAt >= CUTOFF) {
			await emitBillingEvent(
				workspaceId,
				{ event: 'subscription_canceled', plan, stripeSubscriptionId: sub.id },
				{ timestamp: canceledAt },
			)
			counters.emittedCanceled += 1
		}
	}

	if (sub.status === 'past_due' || sub.status === 'unpaid') {
		// Stripe doesn't expose a "became past_due at" timestamp on the
		// subscription object. Stamp the past_due event with `now` so it's
		// always after the started event for the same sub — HogQL's
		// status-over-time query then resolves the right order.
		await emitBillingEvent(workspaceId, {
			event: 'subscription_past_due',
			plan,
			stripeSubscriptionId: sub.id,
		})
		counters.emittedPastDue += 1
	}
}

async function main(): Promise<void> {
	if (!process.env.POSTHOG_API_KEY) {
		throw new Error('POSTHOG_API_KEY is required — backfill would silently no-op otherwise')
	}
	const stripeEnv = readStripeEnv()
	const stripe = getStripeClient(stripeEnv)
	const counters: Counters = {
		scanned: 0,
		skippedNoWorkspace: 0,
		skippedNoPaidPlan: 0,
		skippedNoSubId: 0,
		emittedStarted: 0,
		emittedCanceled: 0,
		emittedPastDue: 0,
	}

	// `status: 'all'` includes canceled subs so we can emit subscription_canceled
	// for churn that happened in the live window. We expand `customer` so the
	// metadata fallback works without a second round-trip per sub.
	for await (const sub of stripe.subscriptions.list({
		status: 'all',
		limit: 100,
		expand: ['data.customer'],
	})) {
		// Anything created before the cutoff AND not currently in a transitional
		// state we'd emit for can be skipped. Created-before + still active = no
		// event in the window. Created-before + canceled-after = canceled is
		// caught below via the cancel-timestamp check; we run processSubscription
		// for those too.
		const createdAt = new Date(sub.created * 1000)
		const canceledAtSec = sub.canceled_at ?? sub.ended_at
		const canceledAt = canceledAtSec ? new Date(canceledAtSec * 1000) : null
		const isCanceledInWindow = canceledAt !== null && canceledAt >= CUTOFF
		const isPastDue = sub.status === 'past_due' || sub.status === 'unpaid'
		if (createdAt < CUTOFF && !isCanceledInWindow && !isPastDue) continue
		await processSubscription(sub, stripeEnv, counters)
	}

	console.log('Backfill complete', JSON.stringify(counters, null, 2))
}

main().catch((err) => {
	console.error('Backfill failed:', err)
	process.exit(1)
})
