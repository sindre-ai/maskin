import { z } from '@hono/zod-openapi'
import { type CallClientState, decodeClientState } from './client'

/**
 * Telnyx v2 webhook envelope: { data: { id, event_type, occurred_at, payload }, meta }.
 * data.id is the event_id the webhook route dedupes on.
 */
const envelopeSchema = z.object({
	data: z
		.object({
			id: z.string().min(1),
			event_type: z.string().min(1),
			occurred_at: z.string().optional(),
			payload: z.record(z.unknown()).default({}),
		})
		.passthrough(),
})

const callPayload = z
	.object({
		call_control_id: z.string().min(1),
		call_session_id: z.string().optional(),
		client_state: z.string().nullish(),
		from: z.string().optional(),
		to: z.string().optional(),
	})
	.passthrough()

const callInitiatedPayload = callPayload.extend({
	start_time: z.string().optional(),
})

const callAnsweredPayload = callPayload.extend({
	start_time: z.string().optional(),
})

const callHangupPayload = callPayload.extend({
	hangup_cause: z.string().optional(),
	hangup_source: z.string().optional(),
	start_time: z.string().optional(),
	end_time: z.string().optional(),
	/** Seconds the leg was connected. */
	duration_s: z.number().optional(),
	recording_url: z.string().nullish(),
	transcript_url: z.string().nullish(),
})

const machineDetectionPayload = callPayload.extend({
	result: z.string(),
})

const transcriptionFinalPayload = callPayload.extend({
	transcript: z.string().optional(),
	role: z.string().optional(),
	is_final: z.boolean().optional(),
})

const toolInvocationPayload = callPayload.extend({
	tool_name: z.string(),
	tool_input: z.record(z.unknown()).default({}),
})

const transferPayload = callPayload.extend({
	target: z.string().optional(),
	outcome: z.string().optional(),
})

const base = {
	event_id: z.string().min(1),
	occurred_at: z.string().optional(),
}

export const telnyxEventSchema = z.discriminatedUnion('event_type', [
	z.object({ ...base, event_type: z.literal('call.initiated'), payload: callInitiatedPayload }),
	z.object({ ...base, event_type: z.literal('call.answered'), payload: callAnsweredPayload }),
	z.object({ ...base, event_type: z.literal('call.hangup'), payload: callHangupPayload }),
	z.object({
		...base,
		event_type: z.literal('call.machine.premium.detection.ended'),
		payload: machineDetectionPayload,
	}),
	z.object({
		...base,
		event_type: z.literal('transcription.final'),
		payload: transcriptionFinalPayload,
	}),
	z.object({
		...base,
		event_type: z.literal('assistant.tool_invocation'),
		payload: toolInvocationPayload,
	}),
	z.object({
		...base,
		event_type: z.literal('call.transfer.completed'),
		payload: transferPayload,
	}),
	z.object({ ...base, event_type: z.literal('call.transfer.failed'), payload: transferPayload }),
])

export type TelnyxEvent = z.infer<typeof telnyxEventSchema>
export type TelnyxEventType = TelnyxEvent['event_type']

export type ParsedTelnyxWebhook =
	| { kind: 'known'; event: TelnyxEvent }
	/** Valid envelope, event type we do not consume (yet). 200 and log. */
	| { kind: 'unknown'; eventId: string; eventType: string }
	/** Not a Telnyx envelope, or a known type with a malformed payload. */
	| { kind: 'invalid'; eventId: string | null; eventType: string | null; reason: string }

export function parseTelnyxWebhook(body: unknown): ParsedTelnyxWebhook {
	const env = envelopeSchema.safeParse(body)
	if (!env.success) {
		return { kind: 'invalid', eventId: null, eventType: null, reason: 'not a Telnyx envelope' }
	}
	const { id, event_type, occurred_at, payload } = env.data.data
	const known = telnyxEventSchema.safeParse({
		event_id: id,
		event_type,
		occurred_at,
		payload,
	})
	if (known.success) return { kind: 'known', event: known.data }

	const isKnownType = telnyxEventSchema.options.some((o) => o.shape.event_type.value === event_type)
	if (!isKnownType) return { kind: 'unknown', eventId: id, eventType: event_type }
	return {
		kind: 'invalid',
		eventId: id,
		eventType: event_type,
		reason: known.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
	}
}

/** contact_id / workspace_id / dial_attempt_n the dialer stamped on the call, if present. */
export function clientStateOf(event: TelnyxEvent): CallClientState | null {
	return decodeClientState(event.payload.client_state)
}

export type HangupKind = 'normal' | 'no_answer' | 'busy' | 'machine_detected' | 'failed'

/**
 * Collapses Telnyx hangup causes onto the five outcomes the reducer cares
 * about. Causes outside the table are treated as failed (non-recoverable, goes
 * to manual review) rather than guessed at.
 */
export function classifyHangup(cause: string | undefined): HangupKind {
	switch ((cause ?? '').toLowerCase()) {
		case 'normal_clearing':
			return 'normal'
		case 'no_answer':
		case 'timeout':
		case 'no_user_response':
			return 'no_answer'
		case 'busy':
		case 'user_busy':
			return 'busy'
		case 'machine_detected':
			return 'machine_detected'
		default:
			return 'failed'
	}
}
