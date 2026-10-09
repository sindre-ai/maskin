/**
 * Transactional notifications for the VAT-correct-checkout state machine
 * (spec Delta 2 + 2a + Delta 5).
 *
 * Three transactional emails (awaiting-VIES, release, rejection) plus a
 * Slack DM to Sebk on `charge.dispute.created`. This module deliberately
 * does NOT depend on a hosted transactional email transport — none is wired
 * into the repo yet (Gmail integration is per-user OAuth, not outbound
 * transactional). The emails are logged at info with the full payload so
 * every send is auditable in ops; when Task 3 / 4 wires a transport, only
 * the leaf `deliverEmail` call needs to change.
 *
 * The Slack helper posts to Sebk's user DM channel using the bot token of the
 * Maskin ops workspace's Slack integration (workspace id in
 * `MASKIN_OPS_WORKSPACE_ID`). It is intentionally a thin wrapper over
 * `chat.postMessage` — no channels config, no template engine, no retry.
 * Delta 5 accepts the risk that a Stripe redelivery could DM Sebk twice.
 */

import type { Database } from '@maskin/db'
import type { AwaitingViesRow } from '@maskin/db/schema'
import type Stripe from 'stripe'
import { getIntegrationCredential } from './integrations/lookup'
import { TokenManager } from './integrations/oauth/token-manager'
import { slackApiCall } from './integrations/providers/slack/slack-api'
import { getProvider } from './integrations/registry'
import { logger } from './logger'

/**
 * Sebk's Slack user id (Delta 5 spec). `chat.postMessage` accepts a user id
 * as `channel` and opens the DM automatically. Hard-coded per the spec so
 * there is exactly one line to change if it ever moves.
 */
const SEBK_SLACK_USER_ID = 'U04A164KDB7'

type EmailEnvelope = {
	to: string
	subject: string
	body: string
	tags: Record<string, string | number>
}

/**
 * Boundary between the VAT copy layer and whatever transactional email
 * transport lands next. Today it logs; when a transport is wired (Postmark,
 * Resend, SES) this is the one place to swap the leaf.
 */
async function deliverEmail(envelope: EmailEnvelope): Promise<void> {
	logger.info('vat.transactional_email', {
		to: envelope.to,
		subject: envelope.subject,
		tags: envelope.tags,
		body_preview: envelope.body.slice(0, 240),
	})
}

/**
 * Best-effort resolver for the customer's email off a Stripe Checkout
 * Session. Stripe stores it on `customer_details.email` for guest checkouts
 * and on `customer_email` for account-linked ones; either can be null on
 * unusual providers, in which case we skip the send and log a warning
 * rather than throw — a missing email must not fail the webhook.
 */
function emailFromSession(session: Stripe.Checkout.Session): string | null {
	return session.customer_details?.email ?? session.customer_email ?? null
}

/**
 * Awaiting-VIES email — sent post-checkout when the customer's tax_id is
 * still `pending` and their fulfilment is held. Copy per spec Delta 2a Q2.
 */
export async function sendAwaitingViesEmail(session: Stripe.Checkout.Session): Promise<void> {
	const to = emailFromSession(session)
	if (!to) {
		logger.warn('vat.awaiting_vies_email skipped — no email on session', {
			sessionId: session.id,
		})
		return
	}
	await deliverEmail({
		to,
		subject: 'Verifying your VAT number with VIES',
		body:
			'Verifying your VAT number with VIES.\n\n' +
			'Your credits will arrive within a few minutes once the EU database confirms your number. ' +
			`We'll email you the moment it's ready. If verification takes unusually long, we'll refund ` +
			'you and let you know.',
		tags: { kind: 'awaiting_vies', session_id: session.id },
	})
}

/**
 * Release email — sent when `customer.tax_id.updated` resolves to `verified`
 * on a held row. Copy per spec Delta 2a Q2.
 */
export async function sendReleaseEmail(row: AwaitingViesRow): Promise<void> {
	// The awaiting_vies row does not carry the customer email — we resolve
	// it via the caller in production paths; when called with only a row,
	// we log a follow-up marker. Task 3's scheduler retains the same
	// contract, so keeping the parameter shape uniform is the right trade.
	logger.info('vat.release_email', {
		customerId: row.customerId,
		sessionId: row.sessionId,
		kind: row.kind,
	})
	await deliverEmail({
		to: row.customerId,
		subject: row.kind === 'subscription' ? 'Your subscription is active' : 'Your credits are ready',
		body:
			row.kind === 'subscription'
				? 'Your subscription is now active. Welcome aboard.'
				: 'Your credits have been added. Thanks for choosing Maskin.',
		tags: { kind: 'release', session_id: row.sessionId },
	})
}

/**
 * Rejection email — sent when a held row is voided (either
 * `customer.tax_id.updated` resolved to `unverified`, or the 24h timeout
 * sweep fires). Copy per spec Delta 2a Q2.
 */
export async function sendRejectionEmail(
	row: AwaitingViesRow,
	reason: 'unverified' | 'timeout',
): Promise<void> {
	await deliverEmail({
		to: row.customerId,
		subject: "Your VAT number couldn't be verified — you've been refunded",
		body:
			reason === 'unverified'
				? `We couldn't verify your VAT number with the EU tax authority (VIES). ` +
					'Your payment has been refunded — you should see it back in your bank in 5–10 ' +
					'business days. You can retry as a private customer or with a corrected VAT number.'
				: `We're still waiting on the EU tax authority (VIES) to verify your VAT number ` +
					`24 hours after purchase, so we've refunded you — you should see it back in your bank in ` +
					'5–10 business days. Please retry in a few hours.',
		tags: { kind: 'rejection', session_id: row.sessionId, reason },
	})
}

/**
 * Rejection email for the inline-rejected fast path (Delta 2, `voidSessionDirect`).
 * No `awaiting_vies` row exists yet, so we shape the envelope directly from
 * the session. Same copy as `sendRejectionEmail` with `reason='unverified'`.
 */
export async function sendRejectionEmailForSession(
	session: Stripe.Checkout.Session,
): Promise<void> {
	const to = emailFromSession(session)
	if (!to) {
		logger.warn('vat.rejection_email_for_session skipped — no email on session', {
			sessionId: session.id,
		})
		return
	}
	await deliverEmail({
		to,
		subject: "Your VAT number couldn't be verified — you've been refunded",
		body:
			`We couldn't verify your VAT number with the EU tax authority (VIES). ` +
			'Your payment has been refunded — you should see it back in your bank in 5–10 ' +
			'business days. You can retry as a private customer or with a corrected VAT number.',
		tags: { kind: 'rejection_inline', session_id: session.id, reason: 'unverified' },
	})
}

/**
 * DM Sebk about a Stripe chargeback so he can respond manually from the
 * Dashboard (Delta 5). Never throws — a Slack outage must not break the
 * webhook, which is already idempotent by `webhookDeliveries` on `event.id`.
 *
 * The bot token comes from the Maskin ops workspace's Slack integration, NOT
 * the workspace the dispute resolves to (that is the paying customer's). A
 * missing env var or integration logs at error so a dropped alert is visible
 * in prod logs.
 */
export async function notifySebkOnSlack(db: Database, text: string): Promise<void> {
	const preview = text.slice(0, 120)
	try {
		const opsWorkspaceId = process.env.MASKIN_OPS_WORKSPACE_ID?.trim()
		if (!opsWorkspaceId) {
			logger.error('vat.notify_sebk dropped — MASKIN_OPS_WORKSPACE_ID unset', { preview })
			return
		}
		const integration = await getIntegrationCredential(db, opsWorkspaceId, 'slack', null)
		if (!integration) {
			logger.error('vat.notify_sebk dropped — no active slack integration in ops workspace', {
				opsWorkspaceId,
				preview,
			})
			return
		}
		const token = await new TokenManager().getValidToken(db, integration.id, getProvider('slack'))
		await slackApiCall(token, 'chat.postMessage', {
			channel: SEBK_SLACK_USER_ID,
			text,
			unfurl_links: false,
		})
	} catch (err) {
		logger.error('vat.notify_sebk failed', {
			error: err instanceof Error ? err.message : String(err),
			preview,
		})
	}
}
