import { PAID_PLANS } from '@maskin/shared'
import type Stripe from 'stripe'
import { CREDIT_TOPUP_METADATA_KIND, LINKEDIN_ADDON_METADATA_KIND } from '../stripe'
import { type PosthogEventProps, capturePosthogEvent } from './posthog'

// Server-side billing events for the revenue tiles (bet "Product analytics for web and iPhone",
// task "Send billing events from Stripe"). Stripe is the source of truth: every number here is
// read from the Stripe object the webhook just received, never from our own settings.
//
// Shared properties on every event below:
//   workspace_id    plain property (the shared capture adds the workspace group from it)
//   plan            starter, pro, team, ultra, trial or unknown
//   interval        month, year, week, day, or null when the Stripe object does not say
//   amount_minor    what Stripe charged or will charge, in minor units of `currency`
//   currency        lower case ISO code as Stripe sends it (dkk, usd, eur). Never summed across currencies.
//   livemode        true for real money, false for Stripe test mode
//
// Ids, numbers, booleans and categories only: never a name, an email or a Stripe free-text field.

/** All plans bill monthly today (plan-pricing.ts holds monthly prices). Used where the Stripe object has no interval. */
export const PLAN_BILLING_INTERVAL = 'month'

export interface BillingEvent {
	name: string
	distinctId: string
	props: PosthogEventProps
}

/** What a Stripe checkout session was for, so a credit top-up is never read as a subscription payment. */
export type CheckoutKind = 'subscription' | 'credit_topup' | 'linkedin_addon' | 'other'

export function checkoutKind(session: Stripe.Checkout.Session): CheckoutKind {
	if (session.metadata?.kind === CREDIT_TOPUP_METADATA_KIND) return 'credit_topup'
	if (session.metadata?.kind === LINKEDIN_ADDON_METADATA_KIND) return 'linkedin_addon'
	if (session.mode === 'subscription') return 'subscription'
	return 'other'
}

/** Properties of `checkout_session_completed`, shared by the webhook and the VAT guard that also sends it. */
export function checkoutSessionCompletedProps(
	session: Stripe.Checkout.Session,
	workspaceId: string | null,
	awaitingVies: boolean,
): PosthogEventProps {
	return {
		session_id: session.id,
		mode: session.mode ?? null,
		amount_total: session.amount_total ?? null,
		currency: session.currency ?? null,
		awaiting_vies: awaitingVies,
		kind: checkoutKind(session),
		livemode: session.livemode ?? null,
		...(workspaceId ? { workspace_id: workspaceId } : {}),
	}
}

type Interval = 'day' | 'week' | 'month' | 'year'

/** One price line, from a subscription item or an invoice line. */
interface PriceLine {
	price: Stripe.Price | null
	quantity?: number | null
}

export interface BillingTerms {
	interval: Interval | null
	/** Per billing interval, summed over the plan lines, in minor units. */
	amountMinor: number | null
	/** The same, normalised to one month, so monthly recurring revenue is the latest value per workspace. */
	monthlyAmountMinor: number | null
	currency: string | null
}

function toMonthly(amount: number, interval: Interval, count: number): number {
	const n = count > 0 ? count : 1
	switch (interval) {
		case 'month':
			return Math.round(amount / n)
		case 'year':
			return Math.round(amount / (12 * n))
		case 'week':
			return Math.round((amount * 52) / 12 / n)
		case 'day':
			return Math.round((amount * 365) / 12 / n)
	}
}

/**
 * The recurring terms of the plan lines (the LinkedIn add-on line is left out, it is not the plan).
 * List price: a coupon or a tax line does not change it. Null fields mean Stripe did not say.
 */
export function billingTerms(
	lines: readonly PriceLine[],
	isAddonPrice: (priceId: string | null) => boolean,
): BillingTerms {
	let interval: Interval | null = null
	let currency: string | null = null
	let amount = 0
	let monthly = 0
	let counted = 0
	for (const line of lines) {
		const price = line.price
		if (!price || isAddonPrice(price.id)) continue
		if (typeof price.unit_amount !== 'number') continue
		const quantity = typeof line.quantity === 'number' && line.quantity > 0 ? line.quantity : 1
		const lineAmount = price.unit_amount * quantity
		amount += lineAmount
		interval ??= price.recurring?.interval ?? null
		currency ??= price.currency ?? null
		if (price.recurring) {
			monthly += toMonthly(lineAmount, price.recurring.interval, price.recurring.interval_count)
		}
		counted++
	}
	if (counted === 0)
		return { interval: null, amountMinor: null, monthlyAmountMinor: null, currency }
	return {
		interval,
		amountMinor: amount,
		monthlyAmountMinor: interval ? monthly : null,
		currency,
	}
}

export function planLabel(plan: string | null | undefined): string {
	return PAID_PLANS.find((p) => p === plan) ?? (plan === 'trial' ? 'trial' : 'unknown')
}

function baseProps(
	workspaceId: string,
	plan: string | null | undefined,
	terms: Pick<BillingTerms, 'interval' | 'amountMinor' | 'currency'>,
	livemode: boolean,
): PosthogEventProps {
	return {
		workspace_id: workspaceId,
		plan: planLabel(plan),
		interval: terms.interval,
		amount_minor: terms.amountMinor,
		currency: terms.currency,
		livemode,
	}
}

/** `subscription_started`: a plan subscription now exists and is live. Carries the monthly value. */
export function subscriptionStartedEvent(p: {
	workspaceId: string
	plan: string | null | undefined
	terms: BillingTerms
	livemode: boolean
}): BillingEvent {
	return {
		name: 'subscription_started',
		distinctId: p.workspaceId,
		props: {
			...baseProps(p.workspaceId, p.plan, p.terms, p.livemode),
			monthly_amount_minor: p.terms.monthlyAmountMinor,
		},
	}
}

/**
 * `trial_converted`: the workspace was on the free trial and has now started a paid subscription.
 * `trial_started` is sent by the trial card flow itself, so it is not repeated here.
 */
export function trialConvertedEvent(p: {
	workspaceId: string
	plan: string | null | undefined
	terms: BillingTerms
	livemode: boolean
	/** Whole days from the trial start to now, when the trial had started with a card. */
	daysInTrial: number | null
}): BillingEvent {
	return {
		name: 'trial_converted',
		distinctId: p.workspaceId,
		props: {
			...baseProps(p.workspaceId, p.plan, p.terms, p.livemode),
			monthly_amount_minor: p.terms.monthlyAmountMinor,
			days_in_trial: p.daysInTrial,
		},
	}
}

/** `subscription_changed`: the plan or the price of a live subscription moved. The new value is the current one. */
export function subscriptionChangedEvent(p: {
	workspaceId: string
	plan: string | null | undefined
	planBefore: string | null | undefined
	terms: BillingTerms
	livemode: boolean
}): BillingEvent {
	return {
		name: 'subscription_changed',
		distinctId: p.workspaceId,
		props: {
			...baseProps(p.workspaceId, p.plan, p.terms, p.livemode),
			monthly_amount_minor: p.terms.monthlyAmountMinor,
			plan_before: planLabel(p.planBefore),
		},
	}
}

/** `subscription_cancelled`: the subscription ended. The monthly value is what is lost. */
export function subscriptionCancelledEvent(p: {
	workspaceId: string
	plan: string | null | undefined
	terms: BillingTerms
	livemode: boolean
	/** Stripe's own category (cancellation_requested, payment_failed, payment_disputed). Never the free-text comment. */
	reason: string | null
	daysSubscribed: number | null
}): BillingEvent {
	return {
		name: 'subscription_cancelled',
		distinctId: p.workspaceId,
		props: {
			...baseProps(p.workspaceId, p.plan, p.terms, p.livemode),
			monthly_amount_minor: p.terms.monthlyAmountMinor,
			reason: p.reason,
			days_subscribed: p.daysSubscribed,
		},
	}
}

/** `renewal_paid`: a recurring invoice for a plan subscription was paid. The first payment is checkout_completed. */
export function renewalPaidEvent(p: {
	workspaceId: string
	plan: string | null | undefined
	terms: BillingTerms
	/** What the customer paid for this invoice, tax included, in minor units. */
	amountPaidMinor: number
	livemode: boolean
}): BillingEvent {
	return {
		name: 'renewal_paid',
		distinctId: p.workspaceId,
		props: {
			...baseProps(
				p.workspaceId,
				p.plan,
				{ ...p.terms, amountMinor: p.amountPaidMinor },
				p.livemode,
			),
			monthly_amount_minor: p.terms.monthlyAmountMinor,
		},
	}
}

/** `refund_issued`: money went back to a customer. Amount is this refund only, not the running total. */
export function refundIssuedEvent(p: {
	workspaceId: string
	plan: string | null | undefined
	amountMinor: number
	currency: string
	livemode: boolean
	/** subscription when the charge paid an invoice, otherwise one_time (a credit top-up). */
	kind: 'subscription' | 'one_time'
	fullyRefunded: boolean
}): BillingEvent {
	return {
		name: 'refund_issued',
		distinctId: p.workspaceId,
		props: {
			...baseProps(
				p.workspaceId,
				p.plan,
				{ interval: null, amountMinor: p.amountMinor, currency: p.currency },
				p.livemode,
			),
			kind: p.kind,
			fully_refunded: p.fullyRefunded,
		},
	}
}

/** Sends after the database work has committed, so a rolled-back delivery that Stripe retries sends nothing twice. */
export async function sendBillingEvents(events: readonly BillingEvent[]): Promise<void> {
	await Promise.all(events.map((e) => capturePosthogEvent(e.name, e.distinctId, e.props)))
}
