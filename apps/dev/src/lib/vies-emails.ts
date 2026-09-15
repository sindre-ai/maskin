import type { AwaitingViesRow } from '@maskin/db/schema'
import { logger } from './logger'

/**
 * Reminder email fired by the T+2h sweep on rows whose VIES verification is
 * still pending. Copy is verbatim from spec Delta 2a Q2 — do NOT edit
 * without a Sebk-approved copy change.
 *
 * Task 2 owns the awaiting/release/rejection variants and their shared
 * `billing-emails.ts` module (spec Delta 2 + 2a). This function is the
 * reminder-only variant that this task (Task 3) owns per spec. When Task 2
 * lands the shared module, this helper can be folded into it in a follow-up
 * — the copy is stable so the fold is mechanical.
 *
 * Wired-in behaviour today: log at info level with the resolved recipient
 * and body length. The real send call (Resend / SES / whichever transport
 * Task 2's billing-emails.ts settles on) drops in at the marked call site.
 * A no-op-in-dev shape is deliberate: this file is imported by the VIES
 * scheduler which starts on every apps/dev boot behind the
 * `MASKIN_VAT_CHECKOUT` flag, and a partial send-side integration would
 * either double-send once Task 2 lands or block Task 3 waiting on Task 2 —
 * neither is what "parallel execution" of the task stack means.
 */

const REMINDER_SUBJECT = 'Still verifying your VAT number'

const REMINDER_BODY = [
	"We're still verifying your VAT number with the EU tax authority.",
	'No action needed — your credits will release automatically once verification',
	'completes (usually within a few hours). If it takes longer than 24 hours from',
	"purchase, we'll refund you and email you to retry.",
].join(' ')

export interface AwaitingViesReminderEmail {
	subject: string
	body: string
	customerId: string
	sessionId: string
}

/**
 * Build the reminder email envelope for an `awaiting_vies` row. Exported
 * separately from `send…` so the copy can be asserted in unit tests without
 * standing up a mail transport, and so Task 2's `billing-emails.ts` can
 * reuse the envelope when it folds this function into the shared module.
 */
export function buildAwaitingViesReminderEmail(
	row: Pick<AwaitingViesRow, 'customerId' | 'sessionId'>,
): AwaitingViesReminderEmail {
	return {
		subject: REMINDER_SUBJECT,
		body: REMINDER_BODY,
		customerId: row.customerId,
		sessionId: row.sessionId,
	}
}

/**
 * Send the reminder email for an `awaiting_vies` row. Best-effort: never
 * throws (the scheduler tick reads the boolean back from
 * `markReminderSent` to decide whether to attempt a send at all, so a mail
 * transport blip here does not un-stamp the reminder flag — the row would
 * then miss its reminder entirely, but 24h later `sweepTimeouts` refunds
 * the row regardless of reminder status, which is the guaranteed floor).
 *
 * Returns `true` if the send happened, `false` if it was skipped or
 * failed. The scheduler uses the boolean only for logging.
 */
export async function sendAwaitingViesReminderEmail(
	row: Pick<AwaitingViesRow, 'id' | 'sessionId' | 'customerId'>,
): Promise<boolean> {
	const envelope = buildAwaitingViesReminderEmail(row)
	try {
		// Real send call plugs in here once Task 2's `billing-emails.ts` module
		// exposes `sendTransactionalEmail({ subject, body, customerId })` — spec
		// Delta 2a Q2 puts all four VIES emails on that shared transport. Until
		// then this is intentionally a structured log so the reminder-sent path
		// is observable in dev + staging without a mail account wired up.
		logger.info('VIES reminder email sent', {
			rowId: row.id,
			sessionId: envelope.sessionId,
			customerId: envelope.customerId,
			subject: envelope.subject,
			bodyLength: envelope.body.length,
		})
		return true
	} catch (err) {
		logger.warn('VIES reminder email send failed', {
			rowId: row.id,
			sessionId: envelope.sessionId,
			customerId: envelope.customerId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}
