import { capturePosthogEvent } from './posthog'

/**
 * PostHog captures for the VIES-hold lifecycle. This module owns only the
 * events fired by Task 3's scheduler primitive — the T+2h reminder send
 * (`vies_hold_reminder_sent`). Task 2 owns the webhook-driven captures
 * (`stripe_tax_id_verified`, `stripe_tax_id_rejected`,
 * `stripe_dispute_created`) and Task 1 owns the always-false initial
 * `checkout_session_completed` capture — those will land in a sibling
 * `stripe-events.ts` module and this file stays scoped to reminders.
 *
 * Distinct id is the Stripe **customer id**, per spec Delta 4. `session_id`
 * and `minutes_elapsed` are the only properties. Best-effort per
 * `capturePosthogEvent` — never throws.
 */

export interface ViesReminderSentProps {
	customerId: string
	sessionId: string
	/** Whole minutes since `awaiting_vies.created_at`. */
	minutesElapsed: number
}

export async function trackViesReminderSent(p: ViesReminderSentProps): Promise<void> {
	await capturePosthogEvent('vies_hold_reminder_sent', p.customerId, {
		session_id: p.sessionId,
		minutes_elapsed: p.minutesElapsed,
	})
}
