import { z } from '@hono/zod-openapi'
import { type HangupKind, classifyHangup } from '../../integrations/providers/telnyx/events'
import { addWorkdays, copenhagenDay } from './workdays'

/**
 * The only writer of contact voice status. Every webhook handler and the dialer
 * go through advance(); nothing else assigns contact.status or next_dial_at.
 * advance() is pure: it returns the next status, a metadata patch and the side
 * effects to run. apply.ts persists the first two and runs the third.
 */

export const VOICE_STATUSES = [
	'voice_queued',
	'voice_dialing',
	'voice_answered',
	'voice_no_answer',
	'voice_busy',
	'voice_voicemail',
	'voice_declined',
	'voice_meeting_booked',
	'voice_warm_transferred',
	'voice_failed',
] as const
export type VoiceStatus = (typeof VOICE_STATUSES)[number]

// Absorbing: no event moves a contact out of these. voice_declined is DNC-listed
// (DNC gate check 2), so a late call.initiated must never revive it. voice_failed
// is terminal for the retry machine but not absorbing: a human can requeue it.
const ABSORBING: ReadonlySet<string> = new Set<VoiceStatus>([
	'voice_declined',
	'voice_meeting_booked',
	'voice_warm_transferred',
])

export const MAX_NO_ANSWER_ATTEMPTS = 3
export const MAX_SAME_DAY_BUSY_ATTEMPTS = 2
export const MAX_VOICEMAIL_RETRIES = 1
const BUSY_RETRY_MS = 2 * 60 * 60 * 1000

export const voiceContactSchema = z.object({
	status: z.string(),
	metadata: z.record(z.unknown()).nullable().optional(),
})
export type VoiceContact = z.infer<typeof voiceContactSchema>

const callIdField = z.string().min(1)
const endpoints = { to: z.string().optional(), from: z.string().optional() }

export const voiceEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('call_initiated'),
		callId: callIdField,
		/** From the dialer's client_state. Absent: previous attempt + 1. */
		dialAttemptN: z.number().int().positive().optional(),
		...endpoints,
	}),
	z.object({ type: z.literal('call_answered'), callId: callIdField, ...endpoints }),
	z.object({
		type: z.literal('call_hangup'),
		callId: callIdField,
		/** Raw Telnyx hangup_cause. */
		cause: z.string().optional(),
		durationS: z.number().optional(),
		...endpoints,
	}),
	z.object({
		type: z.literal('machine_detection'),
		callId: callIdField,
		result: z.string(),
		...endpoints,
	}),
	z.object({ type: z.literal('transfer_completed'), callId: callIdField }),
	z.object({ type: z.literal('transfer_failed'), callId: callIdField }),
	/** Telnyx REST 5xx / connect-timeout that survived the retry helper. */
	z.object({ type: z.literal('rest_failure'), reason: z.string() }),
])
export type VoiceEvent = z.infer<typeof voiceEventSchema>

export type SmsMode = 'missed_call_nudge' | 'voicemail_followup'

export type VoiceEffect =
	| { type: 'send_sms'; mode: SmsMode; to?: string; from?: string }
	| { type: 'hangup_call'; callId: string }
	| { type: 'dead_letter'; reason: string }

type Outcome = Omit<AdvanceResult, 'staleCall'>

export interface AdvanceResult {
	status: string
	/** Merge into contact.metadata. null values delete the key. */
	metadata: Record<string, unknown>
	effects: VoiceEffect[]
	/** False when the event was stale, a duplicate or otherwise a no-op. */
	applied: boolean
	/** True when the event names a call other than the contact's current one. */
	staleCall: boolean
}

export interface ToolTraceEntry {
	tool_name: string
}

function meta(contact: VoiceContact): Record<string, unknown> {
	return contact.metadata ?? {}
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function noop(contact: VoiceContact): Outcome {
	return { status: contact.status, metadata: {}, effects: [], applied: false }
}

function toolTrace(contact: VoiceContact): ToolTraceEntry[] {
	const raw = meta(contact).voice_tool_trace
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(e): e is ToolTraceEntry =>
			typeof e === 'object' && e !== null && typeof (e as ToolTraceEntry).tool_name === 'string',
	)
}

/** True when the event is for a call other than the one this contact is on. */
function isStaleCall(contact: VoiceContact, callId: string): boolean {
	const last = meta(contact).last_call_id
	return typeof last === 'string' && last !== callId
}

function terminal(
	status: VoiceStatus,
	extra: Record<string, unknown> = {},
	effects: VoiceEffect[] = [],
): Outcome {
	return { status, metadata: { next_dial_at: null, ...extra }, effects, applied: true }
}

function voicemailOutcome(
	contact: VoiceContact,
	now: Date,
	to: string | undefined,
	from: string | undefined,
	extra: Record<string, unknown>,
	leadingEffects: VoiceEffect[] = [],
): Outcome {
	const seen = num(meta(contact).voicemail_n)
	const effects: VoiceEffect[] = [
		...leadingEffects,
		{ type: 'send_sms', mode: 'voicemail_followup', to, from },
	]
	if (seen >= MAX_VOICEMAIL_RETRIES) {
		return terminal(
			'voice_failed',
			{ ...extra, voicemail_n: seen + 1, voice_end_reason: 'machine_detected' },
			effects,
		)
	}
	return {
		status: 'voice_voicemail',
		metadata: {
			...extra,
			voicemail_n: seen + 1,
			voice_end_reason: 'machine_detected',
			next_dial_at: addWorkdays(now, 2).toISOString(),
		},
		effects,
		applied: true,
	}
}

export function advance(
	contact: VoiceContact,
	event: VoiceEvent,
	now: Date = new Date(),
): AdvanceResult {
	const staleCall =
		'callId' in event && event.type !== 'call_initiated' && isStaleCall(contact, event.callId)
	const outcome = ABSORBING.has(contact.status) ? noop(contact) : advanceFrom(contact, event, now)
	return { ...outcome, staleCall }
}

function advanceFrom(contact: VoiceContact, event: VoiceEvent, now: Date): Outcome {
	const m = meta(contact)

	switch (event.type) {
		case 'call_initiated': {
			// Same call replayed (or answered/hangup overtook it): nothing new.
			if (m.last_call_id === event.callId) return noop(contact)
			const today = copenhagenDay(now)
			const attempt = event.dialAttemptN ?? num(m.dial_attempt_n) + 1
			return {
				status: 'voice_dialing',
				metadata: {
					dial_attempt_n: attempt,
					last_call_id: event.callId,
					dial_day: today,
					dial_day_attempts: m.dial_day === today ? num(m.dial_day_attempts) + 1 : 1,
					amd_result: null,
					voice_tool_trace: [],
					next_dial_at: null,
				},
				effects: [],
				applied: true,
			}
		}

		case 'call_answered': {
			if (isStaleCall(contact, event.callId)) return noop(contact)
			if (contact.status !== 'voice_dialing' && contact.status !== 'voice_queued') {
				return noop(contact)
			}
			return {
				status: 'voice_answered',
				metadata: { last_call_id: event.callId },
				effects: [],
				applied: true,
			}
		}

		case 'machine_detection': {
			if (isStaleCall(contact, event.callId)) return noop(contact)
			const result = event.result.toLowerCase()
			if (result === 'human' || result.startsWith('human_')) {
				return {
					status: contact.status,
					metadata: { amd_result: 'human' },
					effects: [],
					applied: true,
				}
			}
			if (result !== 'machine') return noop(contact)
			// Already resolved as a machine (replay, or the hangup got here first).
			if (m.amd_result === 'machine') return noop(contact)
			return voicemailOutcome(contact, now, event.to, event.from, { amd_result: 'machine' }, [
				{ type: 'hangup_call', callId: event.callId },
			])
		}

		case 'transfer_completed': {
			if (isStaleCall(contact, event.callId)) return noop(contact)
			return terminal('voice_warm_transferred')
		}

		case 'transfer_failed':
			// Falls back to the on-call booking flow; the hangup resolves the status.
			return noop(contact)

		case 'rest_failure':
			return terminal('voice_failed', { voice_end_reason: 'telnyx_rest_failure' }, [
				{ type: 'dead_letter', reason: event.reason },
			])

		case 'call_hangup': {
			if (isStaleCall(contact, event.callId)) return noop(contact)
			const kind: HangupKind = classifyHangup(event.cause)
			// A machine verdict already ran the voicemail path for this call.
			if (
				m.amd_result === 'machine' &&
				(contact.status === 'voice_voicemail' || contact.status === 'voice_failed')
			) {
				return noop(contact)
			}

			switch (kind) {
				case 'normal': {
					if (
						contact.status === 'voice_meeting_booked' ||
						contact.status === 'voice_warm_transferred'
					) {
						return noop(contact)
					}
					const booked = toolTrace(contact).some((e) => e.tool_name === 'confirm_meeting_slot')
					return terminal(booked ? 'voice_meeting_booked' : 'voice_declined')
				}

				case 'no_answer': {
					const attempts = num(m.dial_attempt_n)
					const effects: VoiceEffect[] = [
						{ type: 'send_sms', mode: 'missed_call_nudge', to: event.to, from: event.from },
					]
					if (attempts >= MAX_NO_ANSWER_ATTEMPTS) {
						return terminal('voice_failed', { voice_end_reason: 'no_answer' }, effects)
					}
					return {
						status: 'voice_no_answer',
						metadata: {
							voice_end_reason: 'no_answer',
							next_dial_at: addWorkdays(now, 1).toISOString(),
						},
						effects,
						applied: true,
					}
				}

				case 'busy': {
					if (num(m.dial_day_attempts) >= MAX_SAME_DAY_BUSY_ATTEMPTS) {
						return terminal('voice_failed', { voice_end_reason: 'busy' })
					}
					return {
						status: 'voice_busy',
						metadata: {
							voice_end_reason: 'busy',
							next_dial_at: new Date(now.getTime() + BUSY_RETRY_MS).toISOString(),
						},
						effects: [],
						applied: true,
					}
				}

				case 'machine_detected':
					return voicemailOutcome(contact, now, event.to, event.from, { amd_result: 'machine' })

				case 'failed':
					return terminal('voice_failed', { voice_end_reason: event.cause ?? 'hangup_failed' })
			}
		}
	}
}
