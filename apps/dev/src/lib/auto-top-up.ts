import type { Database } from '@maskin/db'
import { awaitingVies, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import {
	type AUTO_TOP_UP_FAILURE_REASONS,
	AUTO_TOP_UP_REFERENCE_DKK_ORE,
	AUTO_TOP_UP_REFERENCE_USD_CENTS,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import Stripe from 'stripe'
import { evictBillingUsage } from './billing-usage-cache'
import { isEnterpriseWorkspace } from './enterprise'
import { recordEvent } from './events/record-event'
import { logger } from './logger'
import { type StripeEnv, getStripeClient, readStripeEnv } from './stripe'

export type AutoTopUpFailureReason = (typeof AUTO_TOP_UP_FAILURE_REASONS)[number]

/** A claim older than this is treated as abandoned (the process died mid-charge). */
export const AUTO_TOP_UP_CLAIM_TTL_MS = 10 * 60 * 1000

export const AUTO_TOP_UP_EVENT = {
	updated: 'workspace_auto_top_up_updated',
	charged: 'workspace_auto_top_up_charged',
	failed: 'workspace_auto_top_up_failed',
} as const

export const AUTO_TOP_UP_INVOICE_KIND = 'auto_top_up'

/** Amounts in a customer's locked Stripe currency, from the fixed reference. USD cents in, minor units out. */
export function usdCentsToChargeMinor(usdCents: number, currency: string): number {
	switch (currency.toLowerCase()) {
		case 'dkk':
			return Math.round(
				(usdCents * AUTO_TOP_UP_REFERENCE_DKK_ORE) / AUTO_TOP_UP_REFERENCE_USD_CENTS,
			)
		case 'eur':
			return Math.round((usdCents * 4_500) / AUTO_TOP_UP_REFERENCE_USD_CENTS)
		default:
			return usdCents
	}
}

type ChargeOutcome =
	| { ok: true; invoiceId: string }
	| { ok: false; reason: AutoTopUpFailureReason; detail: string }

/**
 * Call AFTER a debit transaction has committed. The debit holds a row lock on
 * the workspace, so the card call must never run inside it; this function is
 * the only place that talks to Stripe and it takes no lock while it does.
 *
 * Never throws: a debit that already committed must not be reported as failed
 * because the top-up could not run.
 *
 * Once per crossing: the claim below is one atomic UPDATE that only matches
 * while the rule is on, healthy, the balance is under the threshold and no
 * other charge is in flight. Concurrent debits race for it and one wins. After
 * a charge the balance is above the threshold again (the amount must exceed
 * it), so the next debit does not match until the balance falls once more.
 */
export async function maybeAutoTopUp(params: {
	db: Database
	workspaceId: string
	/** Attributes the audit events (the session's actor on the debit path). */
	actorId: string
	stripe?: Stripe
	now?: number
}): Promise<void> {
	const { db, workspaceId, actorId } = params
	try {
		const nowMs = params.now ?? Date.now()
		const token = crypto.randomUUID()
		const claimed = await claim(db, workspaceId, token, nowMs)
		if (!claimed) return

		const skip = async (why: string) => {
			logger.info('auto top-up skipped', { workspaceId, why })
			await releaseClaim(db, workspaceId, token)
		}

		if (await isEnterpriseWorkspace(db, workspaceId)) return await skip('enterprise')
		if (claimed.billing.status === 'past_due' || claimed.billing.status === 'canceled') {
			return await skip('billing_status')
		}
		const customerId = claimed.billing.stripe_customer_id
		if (!customerId) return await skip('no_customer')

		let env: StripeEnv
		try {
			env = readStripeEnv()
		} catch {
			return await skip('stripe_not_configured')
		}
		if (!env.priceCreditsCustom) return await skip('no_topup_price')
		const stripe = params.stripe ?? getStripeClient(env)

		// Fail closed while a VAT number check is pending: a held top-up means the
		// customer's tax treatment is not settled, so no unattended charge. A
		// lookup that errors counts as pending.
		if (await vatCheckPending(db, stripe, workspaceId, customerId)) return await skip('vat_pending')

		const outcome = await charge({
			stripe,
			env,
			workspaceId,
			customerId,
			subscriptionId: claimed.billing.stripe_subscription_id ?? null,
			amountCents: claimed.rule.amount_cents,
			token,
		})

		if (!outcome.ok) {
			await recordFailure(db, {
				workspaceId,
				actorId,
				token,
				reason: outcome.reason,
				detail: outcome.detail,
			})
			return
		}
		try {
			await creditCharged(db, {
				workspaceId,
				actorId,
				token,
				invoiceId: outcome.invoiceId,
				amountCents: claimed.rule.amount_cents,
				nowMs,
			})
		} catch (err) {
			// The card is charged but the balance is not credited. Leaving the claim
			// to expire would let the next debit charge the card a second time, so
			// fail the rule instead: no more automatic charges until the owner
			// saves it again, and the event carries the invoice id for a manual fix.
			logger.error('auto top-up charged but credit failed', {
				workspaceId,
				invoiceId: outcome.invoiceId,
				error: err instanceof Error ? err.message : String(err),
			})
			await recordFailure(db, {
				workspaceId,
				actorId,
				token,
				reason: 'charge_error',
				detail: `charged_not_credited ${outcome.invoiceId}`,
			})
		}
	} catch (err) {
		logger.error('auto top-up failed unexpectedly', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

interface Claimed {
	rule: { threshold_cents: number; amount_cents: number }
	billing: { status?: string; stripe_customer_id?: string; stripe_subscription_id?: string }
}

async function claim(
	db: Database,
	workspaceId: string,
	token: string,
	nowMs: number,
): Promise<Claimed | null> {
	const rule = sql`${workspaces.settings}->'auto_top_up'`
	const rows = await db
		.update(workspaces)
		.set({
			settings: sql`jsonb_set(${workspaces.settings}, '{auto_top_up}', (${rule}) || jsonb_build_object('in_flight', jsonb_build_object('token', ${token}::text, 'at', ${nowMs}::bigint)), true)`,
		})
		.where(
			and(
				eq(workspaces.id, workspaceId),
				sql`(${rule}->>'enabled') = 'true'`,
				sql`coalesce(${rule}->>'status', 'ok') = 'ok'`,
				sql`coalesce((${workspaces.settings}->'billing'->>'credit_balance_cents')::bigint, 0) < (${rule}->>'threshold_cents')::bigint`,
				sql`(${rule}->'in_flight' IS NULL OR (${rule}->'in_flight'->>'at')::bigint < ${nowMs - AUTO_TOP_UP_CLAIM_TTL_MS})`,
			),
		)
		.returning({ settings: workspaces.settings })
	const settings = rows[0]?.settings as
		| { auto_top_up?: Claimed['rule']; billing?: Claimed['billing'] }
		| undefined
	if (!settings?.auto_top_up) return null
	return { rule: settings.auto_top_up, billing: settings.billing ?? {} }
}

async function releaseClaim(db: Database, workspaceId: string, token: string) {
	await db
		.update(workspaces)
		.set({
			settings: sql`jsonb_set(${workspaces.settings}, '{auto_top_up}', (${workspaces.settings}->'auto_top_up') - 'in_flight', true)`,
		})
		.where(
			and(
				eq(workspaces.id, workspaceId),
				sql`${workspaces.settings}->'auto_top_up'->'in_flight'->>'token' = ${token}`,
			),
		)
}

async function vatCheckPending(
	db: Database,
	stripe: Stripe,
	workspaceId: string,
	customerId: string,
): Promise<boolean> {
	const [held] = await db
		.select({ id: awaitingVies.id })
		.from(awaitingVies)
		.where(eq(awaitingVies.workspaceId, workspaceId))
		.limit(1)
	if (held) return true
	try {
		const taxIds = await stripe.customers.listTaxIds(customerId, { limit: 100 })
		return taxIds.data.some((t) => t.verification?.status === 'pending')
	} catch (err) {
		logger.warn('auto top-up: tax id lookup failed, treating as pending', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return true
	}
}

async function charge(p: {
	stripe: Stripe
	env: StripeEnv
	workspaceId: string
	customerId: string
	subscriptionId: string | null
	amountCents: number
	token: string
}): Promise<ChargeOutcome> {
	const { stripe, env, workspaceId, customerId, token } = p
	const key = (step: string) => `auto-top-up:${token}:${step}`
	let invoiceId: string | null = null
	try {
		const customer = await stripe.customers.retrieve(customerId)
		if ('deleted' in customer)
			return { ok: false, reason: 'no_payment_method', detail: 'customer deleted' }
		const paymentMethod = await findPaymentMethod(stripe, customer, p.subscriptionId)
		if (!paymentMethod) return { ok: false, reason: 'no_payment_method', detail: 'no saved card' }

		// A Stripe customer's currency is fixed by its first invoice, so charge in it.
		const currency = customer.currency ?? 'usd'
		const product = (await stripe.prices.retrieve(env.priceCreditsCustom as string))
			.product as string

		// An invoice (not a bare PaymentIntent) so Stripe Tax adds VAT on top of the
		// credited amount and the customer gets the invoice document, as with checkout.
		const invoice = await stripe.invoices.create(
			{
				customer: customerId,
				collection_method: 'charge_automatically',
				auto_advance: false,
				automatic_tax: { enabled: true },
				default_payment_method: paymentMethod,
				pending_invoice_items_behavior: 'exclude',
				metadata: { workspace_id: workspaceId, kind: AUTO_TOP_UP_INVOICE_KIND, claim: token },
			},
			{ idempotencyKey: key('invoice') },
		)
		invoiceId = invoice.id
		await stripe.invoiceItems.create(
			{
				customer: customerId,
				invoice: invoice.id,
				price_data: {
					currency,
					product,
					unit_amount: usdCentsToChargeMinor(p.amountCents, currency),
					tax_behavior: 'exclusive',
				},
				quantity: 1,
				metadata: { workspace_id: workspaceId, kind: AUTO_TOP_UP_INVOICE_KIND },
			},
			{ idempotencyKey: key('item') },
		)
		await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: key('finalize') })
		const paid = await stripe.invoices.pay(
			invoice.id,
			{ off_session: true, payment_method: paymentMethod },
			{ idempotencyKey: key('pay') },
		)
		if (paid.status === 'paid') return { ok: true, invoiceId: invoice.id }
		await voidQuietly(stripe, invoice.id)
		return { ok: false, reason: 'charge_error', detail: `invoice ${paid.status}` }
	} catch (err) {
		if (invoiceId) await voidQuietly(stripe, invoiceId)
		if (err instanceof Stripe.errors.StripeCardError) {
			const needsAuth = err.code === 'authentication_required'
			return {
				ok: false,
				reason: needsAuth ? 'authentication_required' : 'card_declined',
				detail: err.decline_code ?? err.code ?? 'card_error',
			}
		}
		return {
			ok: false,
			reason: 'charge_error',
			detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
		}
	}
}

async function findPaymentMethod(
	stripe: Stripe,
	customer: Stripe.Customer,
	subscriptionId: string | null,
): Promise<string | null> {
	const fromCustomer = customer.invoice_settings?.default_payment_method
	if (fromCustomer) return typeof fromCustomer === 'string' ? fromCustomer : fromCustomer.id
	if (subscriptionId) {
		const sub = await stripe.subscriptions.retrieve(subscriptionId)
		const fromSub = sub.default_payment_method
		if (fromSub) return typeof fromSub === 'string' ? fromSub : fromSub.id
	}
	const cards = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 })
	return cards.data[0]?.id ?? null
}

/** A failed or unpaid invoice must not stay open: Stripe would retry it or fold it into the next bill. */
async function voidQuietly(stripe: Stripe, invoiceId: string) {
	try {
		const inv = await stripe.invoices.retrieve(invoiceId)
		if (inv.status === 'draft') await stripe.invoices.del(invoiceId)
		else if (inv.status === 'open') await stripe.invoices.voidInvoice(invoiceId)
	} catch (err) {
		logger.warn('auto top-up: could not void invoice', {
			invoiceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Declined or errored: the balance is untouched, the rule becomes `failed`
 * (shown to the owner, no more automatic tries until they save the rule
 * again) and an event records why. Atomic key write, only if this claim still
 * owns the rule.
 */
async function recordFailure(
	db: Database,
	p: {
		workspaceId: string
		actorId: string
		token: string
		reason: AutoTopUpFailureReason
		detail: string
	},
) {
	const nowMs = Date.now()
	await db
		.update(workspaces)
		.set({
			settings: sql`jsonb_set(${workspaces.settings}, '{auto_top_up}', ((${workspaces.settings}->'auto_top_up') - 'in_flight') || jsonb_build_object('status', 'failed', 'failure_reason', ${p.reason}::text, 'failed_at', ${nowMs}::bigint), true)`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(workspaces.id, p.workspaceId),
				sql`${workspaces.settings}->'auto_top_up'->'in_flight'->>'token' = ${p.token}`,
			),
		)
	await recordEvent(db, {
		workspaceId: p.workspaceId,
		actorId: p.actorId,
		action: AUTO_TOP_UP_EVENT.failed,
		entityType: 'workspace',
		entityId: p.workspaceId,
		data: { reason: p.reason, detail: p.detail },
	})
	logger.warn('auto top-up failed', { workspaceId: p.workspaceId, reason: p.reason })
}

/**
 * The card is charged: credit the balance. Row-locked like the debit and the
 * webhook, because the balance sits inside the settings blob next to
 * `billing`; the ledger row keyed on the invoice id makes a replay a no-op.
 * Only the two keys that change are written (jsonb_set), never the object.
 */
async function creditCharged(
	db: Database,
	p: {
		workspaceId: string
		actorId: string
		token: string
		invoiceId: string
		amountCents: number
		nowMs: number
	},
) {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, p.workspaceId))
			.for('update')
			.limit(1)
		if (!row) return
		const current = Number(
			(row.settings as { billing?: { credit_balance_cents?: number } } | null)?.billing
				?.credit_balance_cents ?? 0,
		)
		const balanceAfter = Math.max(0, Math.floor(current)) + p.amountCents

		// The invoice id goes in the checkout-session column: it is the existing
		// idempotency key for top-up rows and an invoice id never collides with a
		// checkout session id.
		const claimed = await tx
			.insert(workspaceCreditLedger)
			.values({
				workspaceId: p.workspaceId,
				type: 'topup',
				amountCents: p.amountCents,
				balanceAfterCents: balanceAfter,
				stripeCheckoutSessionId: p.invoiceId,
			})
			.onConflictDoNothing({
				target: [workspaceCreditLedger.stripeCheckoutSessionId],
				where: sql`${workspaceCreditLedger.type} = 'topup' AND ${workspaceCreditLedger.stripeCheckoutSessionId} IS NOT NULL`,
			})
			.returning({ id: workspaceCreditLedger.id })
		if (!claimed[0]?.id) return

		await tx
			.update(workspaces)
			.set({
				settings: sql`jsonb_set(jsonb_set(${workspaces.settings}, '{billing,credit_balance_cents}', to_jsonb(${balanceAfter}::bigint), true), '{auto_top_up}', ((${workspaces.settings}->'auto_top_up') - 'in_flight') || jsonb_build_object('last_charged_at', ${p.nowMs}::bigint), true)`,
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, p.workspaceId))

		await recordEvent(tx, {
			workspaceId: p.workspaceId,
			actorId: p.actorId,
			action: AUTO_TOP_UP_EVENT.charged,
			entityType: 'workspace',
			entityId: p.workspaceId,
			data: {
				amount_cents: p.amountCents,
				balance_after_cents: balanceAfter,
				stripe_invoice_id: p.invoiceId,
			},
		})
	})
	evictBillingUsage(p.workspaceId)
}
