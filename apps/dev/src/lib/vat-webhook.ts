/**
 * VAT-correct-checkout state machine — the webhook slice.
 *
 * Handles the four new Stripe event branches that ship with the bet
 * (spec Delta 2, 2a, 5):
 *
 *   • checkout.session.completed — fresh-retrieve ordering-race guard,
 *     three-way branch to `awaiting_vies` UPSERT / `voidSessionDirect` /
 *     fulfil (fall-through to existing route logic).
 *   • customer.tax_id.created — informational log only.
 *   • customer.tax_id.updated — verified → fulfil + delete row;
 *     unverified → void + delete row; unavailable/pending → leave open.
 *   • customer.tax_id.deleted — no-op.
 *
 * All Delta-2 behaviour is gated on `MASKIN_VAT_CHECKOUT`. The Delta-5
 * `charge.dispute.created` branch (also implemented here) is intentionally
 * NOT gated — it produces alerts only, mutates nothing, and is safe to run
 * at any time (spec Delta 5 rationale).
 */

import type { Database } from '@maskin/db'
import { awaitingVies, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import type { AwaitingViesRow } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import { capturePosthogEvent } from './analytics/posthog'
import { logger } from './logger'
import { isVatCheckoutEnabled } from './stripe'
import {
	notifySebkOnSlack,
	sendAwaitingViesEmail,
	sendRejectionEmail,
	sendRejectionEmailForSession,
	sendReleaseEmail,
} from './vat-notifications'

/**
 * Handle a VAT-adjacent Stripe event, if any. Returns
 *   `{ handled: true }`  when the whole event has been dispatched here and
 *                        the caller must NOT fall through to its existing
 *                        switch (e.g. an inline-rejected session, or any
 *                        of the three new `customer.tax_id.*` branches, or
 *                        `charge.dispute.created`).
 *   `{ handled: false }` when the caller should continue with its
 *                        existing per-event logic (e.g. a
 *                        `checkout.session.completed` whose taxIds resolve
 *                        to "fulfil now" — the existing top-up /
 *                        subscription / LinkedIn-addon branch keeps its
 *                        ownership of the fulfil path).
 */
export async function applyVatEventIfHandled(
	db: Database,
	workspaceId: string,
	event: Stripe.Event,
	stripe: Stripe,
): Promise<{ handled: boolean }> {
	// charge.dispute.created runs regardless of the flag — see module docstring.
	if (event.type === 'charge.dispute.created') {
		await handleChargeDisputeCreated(event, stripe)
		return { handled: true }
	}

	if (!isVatCheckoutEnabled()) {
		return { handled: false }
	}

	if (event.type === 'customer.tax_id.created') {
		const taxId = event.data.object as Stripe.TaxId
		logger.info('stripe.customer.tax_id.created', {
			customerId: typeof taxId.customer === 'string' ? taxId.customer : taxId.customer?.id,
			value: taxId.value,
			verificationStatus: taxId.verification?.status ?? null,
		})
		return { handled: true }
	}

	if (event.type === 'customer.tax_id.updated') {
		await handleTaxIdVerification(db, event.data.object as Stripe.TaxId, stripe)
		return { handled: true }
	}

	if (event.type === 'customer.tax_id.deleted') {
		logger.info('stripe.customer.tax_id.deleted (no-op)', {
			customerId: (() => {
				const c = (event.data.object as Stripe.TaxId).customer
				return typeof c === 'string' ? c : (c?.id ?? null)
			})(),
		})
		return { handled: true }
	}

	if (event.type === 'checkout.session.completed') {
		const session = event.data.object as Stripe.Checkout.Session
		return await handleCheckoutSessionCompletedWithGuard(db, workspaceId, session, stripe)
	}

	return { handled: false }
}

/**
 * Fresh-retrieve ordering-race guard + three-way branch on the customer's
 * authoritative tax_id state at completion time (spec Delta 2, Architect
 * fold-in 2 Sep). The snapshot on `session.customer_details.tax_ids` can
 * carry a stale `pending` even after VIES has already resolved (Stripe
 * does not refire `updated` in that case), so we always fresh-read.
 */
async function handleCheckoutSessionCompletedWithGuard(
	db: Database,
	workspaceId: string,
	session: Stripe.Checkout.Session,
	stripe: Stripe,
): Promise<{ handled: boolean }> {
	const customerId = customerIdOf(session.customer)
	let taxIds: Stripe.TaxId[] = []
	if (customerId) {
		try {
			const fresh = await stripe.customers.retrieve(customerId, { expand: ['tax_ids'] })
			if (!('deleted' in fresh)) {
				taxIds = fresh.tax_ids?.data ?? []
			}
		} catch (err) {
			// A Stripe retrieval failure here must NOT strand the completion —
			// the safest fallback is to treat the customer as having no tax
			// state and let the existing fulfil branch run. The state machine
			// still catches up: if a subsequent `customer.tax_id.updated`
			// arrives for a released session, `handleTaxIdVerification` finds
			// no row and no-ops (fast-VIES / not-our-customer case).
			logger.warn('vat.customers.retrieve failed — falling through to fulfil', {
				sessionId: session.id,
				error: err instanceof Error ? err.message : String(err),
			})
			await emitCompletedEvent(session, false)
			return { handled: false }
		}
	}

	const anyPending = taxIds.some((t) => t.verification?.status === 'pending')
	const anyUnverified = taxIds.some((t) => t.verification?.status === 'unverified')

	await emitCompletedEvent(session, anyPending)

	if (anyPending) {
		// Real held path: VIES has not resolved yet. Persist enough to void
		// or fulfil later without re-reading Stripe. For subscription mode,
		// `session.payment_intent` is null (the PI lives on the first
		// invoice) — resolve and cache it now so `voidAwaitingRow` can
		// refund without a second Stripe round-trip on the release/void.
		// (CTO deliverability review fix #3, 10 Sep 2026.)
		let paymentIntentId: string | null =
			typeof session.payment_intent === 'string'
				? session.payment_intent
				: (session.payment_intent?.id ?? null)
		const subscriptionId =
			typeof session.subscription === 'string'
				? session.subscription
				: (session.subscription?.id ?? null)

		if (!paymentIntentId && session.mode === 'subscription' && subscriptionId) {
			try {
				const sub = await stripe.subscriptions.retrieve(subscriptionId, {
					expand: ['latest_invoice.payment_intent'],
				})
				const inv = sub.latest_invoice as Stripe.Invoice | null
				const pi = inv?.payment_intent as Stripe.PaymentIntent | string | null | undefined
				paymentIntentId = typeof pi === 'string' ? pi : (pi?.id ?? null)
			} catch (err) {
				logger.warn('vat.subscription.retrieve for PI resolution failed', {
					sessionId: session.id,
					subscriptionId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		await db
			.insert(awaitingVies)
			.values({
				sessionId: session.id,
				customerId: customerId ?? '',
				kind: session.mode === 'subscription' ? 'subscription' : 'topup',
				paymentIntentId,
				subscriptionId,
				currency: (session.currency ?? 'usd').toLowerCase(),
				amountTotal: session.amount_total ?? 0,
				workspaceId,
			})
			.onConflictDoNothing({ target: awaitingVies.sessionId })
		await sendAwaitingViesEmail(session)
		return { handled: true }
	}

	if (anyUnverified) {
		// Rare: VIES already rejected inline before completion fired. Void
		// directly — do NOT fulfil, do NOT queue.
		await voidSessionDirect(session, stripe)
		if (customerId) {
			await capturePosthogEvent('stripe_tax_id_rejected', customerId, {
				session_id: session.id,
				reason: 'unverified',
			})
		}
		return { handled: true }
	}

	// No tax_id, verified inline (fast-VIES), or non-EU: fall through to
	// existing fulfil branch.
	return { handled: false }
}

/**
 * Route a `customer.tax_id.updated` event to fulfil / void / no-op based
 * on the freshest `verification.status` (spec Delta 2).
 */
async function handleTaxIdVerification(
	db: Database,
	taxId: Stripe.TaxId,
	stripe: Stripe,
): Promise<void> {
	const status = taxId.verification?.status ?? null
	const customerId = typeof taxId.customer === 'string' ? taxId.customer : taxId.customer?.id
	if (!customerId) {
		logger.warn('stripe.customer.tax_id.updated missing customer id — no-op')
		return
	}

	const rows = await db.select().from(awaitingVies).where(eq(awaitingVies.customerId, customerId))
	// rows.length === 0 is CORRECT in two spec-called-out cases:
	//   1. Fast-VIES path — `updated` fired before `session.completed`; the
	//      completion guard fresh-reads the state and fulfils directly.
	//   2. Not-our-customer — some unrelated `tax_id` update.
	if (rows.length === 0) return

	for (const row of rows) {
		if (status === 'verified') {
			await fulfilFromAwaitingRow(db, row)
			await sendReleaseEmail(row)
			await db.delete(awaitingVies).where(eq(awaitingVies.id, row.id))
			await capturePosthogEvent('stripe_tax_id_verified', row.customerId, {
				session_id: row.sessionId,
			})
		} else if (status === 'unverified') {
			await voidAwaitingRow(db, row, 'unverified', stripe)
			await capturePosthogEvent('stripe_tax_id_rejected', row.customerId, {
				session_id: row.sessionId,
				reason: 'unverified',
			})
		}
		// 'unavailable' / 'pending' → leave the row open; Task 3's 24h
		// timeout sweep resolves stranded rows.
	}
}

/**
 * Void the held row's payment (refund topup PI; cancel subscription +
 * refund first invoice for subscription mode). Sends the rejection email
 * and deletes the row. Exported so Task 3's timeout sweep can reuse the
 * same path.
 */
export async function voidAwaitingRow(
	db: Database,
	row: AwaitingViesRow,
	reason: 'unverified' | 'timeout',
	stripe: Stripe,
): Promise<void> {
	try {
		if (row.kind === 'topup') {
			if (row.paymentIntentId) {
				await stripe.refunds.create({
					payment_intent: row.paymentIntentId,
					reason: 'requested_by_customer',
				})
			}
		} else {
			// subscription
			if (row.subscriptionId) {
				await stripe.subscriptions.cancel(row.subscriptionId, {
					invoice_now: false,
					prorate: false,
				})
			}
			if (row.paymentIntentId) {
				await stripe.refunds.create({
					payment_intent: row.paymentIntentId,
					reason: 'requested_by_customer',
				})
			}
		}
	} catch (err) {
		logger.error('vat.voidAwaitingRow — stripe mutation failed; still deleting row', {
			rowId: row.id,
			sessionId: row.sessionId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	await sendRejectionEmail(row, reason)
	await db.delete(awaitingVies).where(eq(awaitingVies.id, row.id))
}

/**
 * Inline-rejected fast path (spec Delta 2). Same shape as
 * `voidAwaitingRow` but takes the session directly — no row was ever
 * written.
 */
async function voidSessionDirect(session: Stripe.Checkout.Session, stripe: Stripe): Promise<void> {
	try {
		if (session.mode === 'payment' && session.payment_intent) {
			const pi =
				typeof session.payment_intent === 'string'
					? session.payment_intent
					: session.payment_intent.id
			await stripe.refunds.create({ payment_intent: pi, reason: 'requested_by_customer' })
		} else if (session.mode === 'subscription' && session.subscription) {
			const subId =
				typeof session.subscription === 'string' ? session.subscription : session.subscription.id
			await stripe.subscriptions.cancel(subId, { invoice_now: false, prorate: false })
			if (session.payment_intent) {
				const pi =
					typeof session.payment_intent === 'string'
						? session.payment_intent
						: session.payment_intent.id
				await stripe.refunds.create({ payment_intent: pi, reason: 'requested_by_customer' })
			}
		}
	} catch (err) {
		logger.error('vat.voidSessionDirect — stripe mutation failed', {
			sessionId: session.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	await sendRejectionEmailForSession(session)
}

/**
 * Release path for a verified held row. For a topup, credit the balance
 * exactly the way `checkout.session.completed`'s topup branch does — the
 * ledger's `stripe_checkout_session_id` UNIQUE index acts as the money
 * idempotency gate so a replayed webhook cannot double-credit.
 *
 * For a subscription, the subscription is already active on Stripe's side
 * (the completion event marked the workspace `active`); there is nothing
 * to write here beyond the audit trail. We rely on the existing
 * `customer.subscription.created` / `.updated` handler to write the plan
 * fields when Stripe emits it — the reverse-charge invoice has already
 * been sent by Stripe.
 */
async function fulfilFromAwaitingRow(db: Database, row: AwaitingViesRow): Promise<void> {
	if (row.kind !== 'topup') {
		logger.info('vat.fulfilFromAwaitingRow subscription — no-op (Stripe drives activation)', {
			rowId: row.id,
			subscriptionId: row.subscriptionId,
		})
		return
	}

	await db.transaction(async (tx) => {
		const [workspace] = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, row.workspaceId))
			.for('update')
			.limit(1)
		if (!workspace) {
			logger.warn('vat.fulfilFromAwaitingRow topup — workspace vanished, dropping', {
				rowId: row.id,
				workspaceId: row.workspaceId,
			})
			return
		}
		const parsed = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
		const currentBilling = parsed.success
			? (parsed.data.billing ?? { plan: 'trial' as const, status: 'incomplete' as const })
			: { plan: 'trial' as const, status: 'incomplete' as const }
		const currentBalance =
			typeof currentBilling.credit_balance_cents === 'number' &&
			currentBilling.credit_balance_cents > 0
				? currentBilling.credit_balance_cents
				: 0
		const balanceAfter = currentBalance + row.amountTotal

		const ledgerClaim = await tx
			.insert(workspaceCreditLedger)
			.values({
				workspaceId: row.workspaceId,
				type: 'topup',
				amountCents: row.amountTotal,
				balanceAfterCents: balanceAfter,
				stripeCheckoutSessionId: row.sessionId,
			})
			.onConflictDoNothing({
				target: [workspaceCreditLedger.stripeCheckoutSessionId],
				where: sql`${workspaceCreditLedger.type} = 'topup' AND ${workspaceCreditLedger.stripeCheckoutSessionId} IS NOT NULL`,
			})
			.returning({ id: workspaceCreditLedger.id })

		if (!ledgerClaim[0]?.id) {
			// Already released by an earlier delivery of this same session
			// (webhook replay). Row deletion below still needs to run.
			logger.info('vat.fulfilFromAwaitingRow — ledger replay suppressed', {
				sessionId: row.sessionId,
			})
			return
		}

		const nextBilling = { ...currentBilling, credit_balance_cents: balanceAfter }
		const merged = {
			...(workspace.settings ?? {}),
			billing: nextBilling,
		}
		await tx
			.update(workspaces)
			.set({ settings: merged, updatedAt: new Date() })
			.where(eq(workspaces.id, row.workspaceId))
	})
}

/**
 * PostHog `checkout_session_completed` — fired from the freshly-guarded
 * branch. Task 1 (VAT foundation) ships an unconditional emitter with
 * `awaiting_vies: false`; this call replaces that emit at the boundary
 * where the guard actually decides. When Task 1's PR reconciles with Task
 * 2's at the aggregate bet merge, the unconditional emitter shrinks to a
 * fallback (guard disabled path) and this one owns the guarded path.
 */
async function emitCompletedEvent(
	session: Stripe.Checkout.Session,
	awaitingVies: boolean,
): Promise<void> {
	const customerId = customerIdOf(session.customer)
	if (!customerId) return
	await capturePosthogEvent('checkout_session_completed', customerId, {
		session_id: session.id,
		mode: session.mode,
		amount_total: session.amount_total ?? 0,
		currency: session.currency ?? null,
		awaiting_vies: awaitingVies,
	})
}

/**
 * Delta 5 — chargeback log-and-alert. NEVER mutates state or credit
 * notes; Sebk owns manual response from the Dashboard.
 */
async function handleChargeDisputeCreated(event: Stripe.Event, stripe: Stripe): Promise<void> {
	const dispute = event.data.object as Stripe.Dispute
	const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
	let invoiceId: string | null = null
	let customerId: string | null = null
	if (chargeId) {
		try {
			const charge = await stripe.charges.retrieve(chargeId, {
				expand: ['invoice', 'payment_intent'],
			})
			const invoice = charge.invoice as Stripe.Invoice | null
			invoiceId = invoice?.id ?? null
			customerId = customerIdOf(charge.customer)
		} catch (err) {
			logger.warn('vat.charge.retrieve failed on dispute — logging with charge id only', {
				disputeId: dispute.id,
				chargeId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	logger.warn('stripe.dispute.created', {
		disputeId: dispute.id,
		chargeId,
		invoiceId,
		customerId,
		amount: dispute.amount,
		currency: dispute.currency,
		reason: dispute.reason,
		status: dispute.status,
		dashboardUrl: `https://dashboard.stripe.com/disputes/${dispute.id}`,
	})

	await capturePosthogEvent('stripe_dispute_created', customerId ?? dispute.id, {
		dispute_id: dispute.id,
		invoice_id: invoiceId,
		amount: dispute.amount,
		currency: dispute.currency,
		reason: dispute.reason,
	})

	const currencyDisplay = (dispute.currency ?? 'usd').toUpperCase()
	const amountFormatted = (dispute.amount / 100).toFixed(2)
	await notifySebkOnSlack(
		[
			':rotating_light: Stripe dispute opened — manual void may be needed.',
			`• Dispute: <https://dashboard.stripe.com/disputes/${dispute.id}|${dispute.id}>`,
			`• Invoice: ${invoiceId ?? '(none)'}`,
			`• Amount: ${amountFormatted} ${currencyDisplay}`,
			`• Reason: ${dispute.reason ?? '(unspecified)'}`,
			'If this was a VAT-verified B2B sale, void the reverse-charge invoice and issue a credit note from the Dashboard.',
		].join('\n'),
	)
}

/**
 * Resolve the workspace id for a `charge.dispute.created` event by
 * following Dispute → Charge → customer, then looking the customer up in
 * `workspaces.settings.billing.stripe_customer_id`. Called by the webhook
 * route's fallback resolver — a Dispute object carries `charge`, not
 * `customer`, so the object-shape helper cannot pull it out sync. (CTO
 * deliverability review fix #2, 10 Sep 2026.)
 */
export async function resolveDisputeWorkspaceId(
	db: Database,
	event: Stripe.Event,
	stripe: Stripe,
): Promise<string | null> {
	if (event.type !== 'charge.dispute.created') return null
	const dispute = event.data.object as Stripe.Dispute
	const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
	if (!chargeId) return null
	try {
		const charge = await stripe.charges.retrieve(chargeId, { expand: ['customer'] })
		const customerId = customerIdOf(charge.customer)
		if (!customerId) return null
		const rows = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(sql`${workspaces.settings}->'billing'->>'stripe_customer_id' = ${customerId}`)
			.limit(1)
		return rows[0]?.id ?? null
	} catch (err) {
		logger.warn('vat.resolveDisputeWorkspaceId failed', {
			disputeId: dispute.id,
			chargeId,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

function customerIdOf(
	customer: Stripe.Charge['customer'] | Stripe.Checkout.Session['customer'],
): string | null {
	if (!customer) return null
	if (typeof customer === 'string') return customer
	if ('id' in customer && typeof customer.id === 'string') return customer.id
	return null
}
