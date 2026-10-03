import { capturePosthogEvent } from '../../analytics/posthog'
import { logger } from '../../logger'
import type { ApplyVoiceEventResult } from './apply'

/**
 * The five voice PostHog events (spec 2b.5 step 10, 2b.3 event routing). The
 * pilot verdict counts call_completed with outcome answered, so these names and
 * properties are a contract: a spec query reads them as written.
 *
 * Emission is best-effort and never part of the webhook's outcome. Each capture
 * is fired without being awaited (the shared helper can wait up to its 2s
 * timeout), and a throw or rejection is logged and swallowed.
 *
 * Callers sit after the webhook's claim commits, so a replayed Telnyx event_id
 * never reaches here. The reducer's applied flag covers a replay under a new id.
 */

export const VOICE_CHANNEL = 'voice_agent'

// The spec example value. The GDPR basis stamped on the contact is the longer
// VOICE_CONSENT_BASIS in send-followup.ts; this is the short form PostHog reads.
export const POST_CALL_EMAIL_COMPLIANCE_BASIS = 'legitimate_interest'

export type CallOutcome = 'answered' | 'voicemail' | 'no_answer'

// A connected call that resolved to any of these still counts as answered: the
// prospect picked up and spoke to the agent (planner reconciliation, 2026-10-03).
const ANSWERED_STATUSES: ReadonlySet<string> = new Set([
	'voice_answered',
	'voice_declined',
	'voice_meeting_booked',
	'voice_warm_transferred',
	'follow_up_later',
])

/**
 * Outcome of a hung-up call from the contact as the reducer left it. Exactly one
 * of answered, voicemail, no_answer: busy, failed and every other call that never
 * connected to a person or a machine is no_answer.
 */
export function callOutcome(status: string, metadata: Record<string, unknown>): CallOutcome {
	if (ANSWERED_STATUSES.has(status)) return 'answered'
	if (status === 'voice_voicemail' || metadata.amd_result === 'machine') return 'voicemail'
	return 'no_answer'
}

function durationSeconds(outcome: CallOutcome, durationS: number | null | undefined): number {
	if (outcome === 'no_answer') return 0
	return typeof durationS === 'number' && Number.isFinite(durationS) && durationS > 0
		? durationS
		: 0
}

function capture(event: string, distinctId: string, properties: Record<string, string | number>) {
	try {
		void Promise.resolve(capturePosthogEvent(event, distinctId, properties)).catch((err) =>
			logger.warn('voice posthog capture failed', {
				event,
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	} catch (err) {
		logger.warn('voice posthog capture failed', {
			event,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

export interface VoiceCaptureInput {
	/** The Telnyx event type that was just applied. */
	eventType: string
	contactId: string
	/** call.hangup duration_s. */
	durationS?: number | null
	result: Extract<ApplyVoiceEventResult, { found: true }>
}

/**
 * Fans the reducer's result out to PostHog: call_initiated, call_answered,
 * call_completed and meeting_booked. Distinct id is the contact id. Properties
 * are exactly the spec's and nothing else.
 */
export function captureVoiceEvents(input: VoiceCaptureInput): void {
	const { eventType, contactId, durationS, result } = input

	if (eventType === 'call.initiated' && result.applied) {
		capture('call_initiated', contactId, {})
	}

	if (eventType === 'call.answered' && result.applied) {
		capture('call_answered', contactId, {})
	}

	// A hangup absorbed by the reducer still ends a connected call (a warm transfer),
	// so the applied flag is not checked here. A hangup for another call is not this
	// contact's current call.
	if (eventType === 'call.hangup' && !result.staleCall) {
		const outcome = callOutcome(result.status, result.metadata)
		capture('call_completed', contactId, {
			outcome,
			duration_seconds: durationSeconds(outcome, durationS),
			channel: VOICE_CHANNEL,
		})
	}

	if (
		result.applied &&
		result.status === 'voice_meeting_booked' &&
		result.previousStatus !== 'voice_meeting_booked'
	) {
		capture('meeting_booked', contactId, { source: VOICE_CHANNEL, contact_id: contactId })
	}
}

/** Fired only after the follow-up email was actually handed to Resend. */
export function capturePostCallEmailSent(contactId: string): void {
	capture('post_call_email_sent', contactId, {
		compliance_basis: POST_CALL_EMAIL_COMPLIANCE_BASIS,
	})
}
