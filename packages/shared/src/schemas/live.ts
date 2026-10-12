import { z } from 'zod'

/**
 * Live mode wire protocol (version 1).
 *
 * Text frames are JSON objects discriminated by `type`. Audio travels in binary
 * frames with a fixed 12-byte little-endian header, see LIVE_AUDIO_HEADER_BYTES.
 * Documented for non-TypeScript clients in docs/reference/live-protocol.md.
 */
export const LIVE_PROTOCOL_VERSION = 1

/** version u8, kind u8, reserved u16, turn_index u32, seq u32. */
export const LIVE_AUDIO_HEADER_BYTES = 12
export const LIVE_AUDIO_KIND_ASSISTANT = 1
export const LIVE_AUDIO_KIND_USER = 2

export const liveInputModeSchema = z.enum(['text', 'audio'])
export type LiveInputMode = z.infer<typeof liveInputModeSchema>

export const liveSessionStatusSchema = z.enum([
	'pending',
	'active',
	'ended',
	'errored',
	'timed_out',
])
export type LiveSessionStatus = z.infer<typeof liveSessionStatusSchema>

export const liveEndReasonSchema = z.enum([
	'user_hangup',
	'network_error',
	'idle_timeout',
	'plan_cap',
	'server_stop',
	'error',
])
export type LiveEndReason = z.infer<typeof liveEndReasonSchema>

// ── REST ────────────────────────────────────────────────────────────────────

export const createLiveSessionSchema = z.object({
	agent_id: z.string().uuid(),
	conversation_id: z.string().uuid().optional(),
	input_mode: liveInputModeSchema.default('audio'),
	/** `briefing` makes the agent open by walking through the day's brief. */
	opening: z.enum(['briefing']).optional(),
})
export type CreateLiveSession = z.infer<typeof createLiveSessionSchema>

export const endLiveSessionSchema = z.object({
	reason: z.enum(['user_hangup', 'network_error']).default('user_hangup'),
})

export const liveSessionResponseSchema = z.object({
	id: z.string().uuid(),
	status: liveSessionStatusSchema,
	workspace_id: z.string().uuid(),
	agent_id: z.string().uuid(),
	conversation_id: z.string().uuid().nullable(),
	input_mode: liveInputModeSchema,
	llm_model: z.string().nullable(),
	tts_model: z.string().nullable(),
	tts_voice: z.string().nullable(),
	stt_model: z.string().nullable(),
	started_at: z.string(),
	timeout_at: z.string(),
})

export const createLiveSessionResponseSchema = z.object({
	live_session: liveSessionResponseSchema,
	ws_url: z.string(),
	protocol_version: z.literal(LIVE_PROTOCOL_VERSION),
})

export const endLiveSessionResponseSchema = z.object({
	live_session_id: z.string().uuid(),
	status: liveSessionStatusSchema,
	ended_reason: z.string().nullable(),
	ended_at: z.string().nullable(),
	duration_ms: z.number().int().nullable(),
	total_cost_usd: z.number(),
	conversation_id: z.string().uuid().nullable(),
	turn_count: z.number().int(),
})

// ── Client -> server frames ─────────────────────────────────────────────────

export const liveClientFrameSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('hello'),
		protocol_version: z.number().int(),
		client: z.enum(['ios', 'web', 'watch']),
		/** false asks for text only (no TTS audio). */
		speak: z.boolean().default(true),
		resume: z.object({ last_turn_index: z.number().int().min(0) }).optional(),
	}),
	z.object({
		type: z.literal('turn.text'),
		client_turn_id: z.string().min(1).max(64),
		text: z.string().min(1).max(8000),
		/** Default true: a new turn while one is running interrupts it. */
		interrupt: z.boolean().default(true),
	}),
	z.object({
		type: z.literal('turn.audio.start'),
		client_turn_id: z.string().min(1).max(64),
		format: z.enum(['pcm_s16le', 'wav', 'm4a']),
		sample_rate: z.number().int().min(8000).max(48000).optional(),
		channels: z.number().int().min(1).max(2).optional(),
	}),
	z.object({ type: z.literal('turn.audio.end'), client_turn_id: z.string().min(1).max(64) }),
	z.object({
		type: z.literal('interrupt'),
		turn_index: z.number().int().min(0),
		/** Last assistant audio `seq` the client actually played. */
		played_seq: z.number().int().min(0).optional(),
	}),
	z.object({
		type: z.literal('confirm'),
		confirmation_id: z.string().min(1).max(64),
		approved: z.boolean(),
	}),
	/** The person pulled an object up on screen; the next turn sees it. */
	z.object({ type: z.literal('context.object'), object_id: z.string().uuid() }),
	z.object({ type: z.literal('ping') }),
	z.object({ type: z.literal('end'), reason: z.enum(['user_hangup', 'network_error']).optional() }),
])
export type LiveClientFrame = z.infer<typeof liveClientFrameSchema>

// ── Server -> client frames ─────────────────────────────────────────────────

export const liveUsageSchema = z.object({
	input_tokens: z.number().int(),
	output_tokens: z.number().int(),
	llm_cost_usd: z.number(),
	tts_characters: z.number().int(),
	tts_cost_usd: z.number(),
	stt_seconds: z.number().int(),
})
export type LiveUsage = z.infer<typeof liveUsageSchema>

export const liveErrorCodeSchema = z.enum([
	'invalid_message',
	'turn_in_progress',
	'plan_cap_exceeded',
	'llm_failed',
	'tts_failed',
	'stt_failed',
	'tool_failed',
	'audio_too_long',
	'client_stalled',
	'unsupported_protocol',
])
export type LiveErrorCode = z.infer<typeof liveErrorCodeSchema>

export const liveServerFrameSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('ready'),
		live_session_id: z.string().uuid(),
		conversation_id: z.string().uuid().nullable(),
		agent: z.object({ id: z.string().uuid(), name: z.string() }),
		llm_model: z.string(),
		tts: z.object({ model: z.string(), voice: z.string() }).nullable(),
		persist_transcripts: z.boolean(),
		resume: z
			.object({ turn_index: z.number().int(), status: z.enum(['interrupted', 'finished']) })
			.optional(),
	}),
	z.object({
		type: z.literal('transcript.user'),
		turn_index: z.number().int(),
		text: z.string(),
		message_id: z.number().int().nullable(),
	}),
	z.object({
		type: z.literal('turn.started'),
		turn_index: z.number().int(),
		client_turn_id: z.string().nullable(),
	}),
	z.object({ type: z.literal('assistant.delta'), turn_index: z.number().int(), text: z.string() }),
	z.object({
		type: z.literal('assistant.sentence'),
		turn_index: z.number().int(),
		sentence_index: z.number().int(),
		text: z.string(),
	}),
	z.object({
		type: z.literal('audio.start'),
		turn_index: z.number().int(),
		format: z.literal('pcm_s16le'),
		sample_rate: z.number().int(),
		channels: z.number().int(),
		bits_per_sample: z.literal(16),
	}),
	z.object({
		type: z.literal('audio.sentence_end'),
		turn_index: z.number().int(),
		sentence_index: z.number().int(),
		last_seq: z.number().int(),
	}),
	z.object({
		type: z.literal('audio.end'),
		turn_index: z.number().int(),
		last_seq: z.number().int(),
	}),
	z.object({
		type: z.literal('tool.started'),
		turn_index: z.number().int(),
		call_id: z.string(),
		/** Human wording, never a tool id or raw argument. */
		label: z.string(),
	}),
	z.object({
		type: z.literal('tool.finished'),
		turn_index: z.number().int(),
		call_id: z.string(),
		label: z.string(),
		ok: z.boolean(),
	}),
	z.object({
		type: z.literal('tool.confirm_required'),
		turn_index: z.number().int(),
		confirmation_id: z.string(),
		label: z.string(),
		summary: z.string(),
		expires_at: z.string(),
	}),
	z.object({
		type: z.literal('object.pulled_up'),
		turn_index: z.number().int(),
		object_id: z.string().uuid(),
		object_type: z.string(),
		title: z.string(),
		status: z.string().nullable(),
	}),
	z.object({
		type: z.literal('turn.finished'),
		turn_index: z.number().int(),
		message_id: z.number().int().nullable(),
		interrupted: z.boolean(),
		usage: liveUsageSchema,
		duration_ms: z.number().int(),
	}),
	z.object({ type: z.literal('pong') }),
	z.object({
		type: z.literal('error'),
		code: liveErrorCodeSchema,
		message: z.string(),
		turn_index: z.number().int().optional(),
	}),
	z.object({ type: z.literal('ended'), reason: liveEndReasonSchema }),
])
export type LiveServerFrame = z.infer<typeof liveServerFrameSchema>

// ── Binary audio frames ─────────────────────────────────────────────────────

export interface LiveAudioHeader {
	kind: typeof LIVE_AUDIO_KIND_ASSISTANT | typeof LIVE_AUDIO_KIND_USER
	turnIndex: number
	seq: number
}

export function encodeLiveAudioFrame(header: LiveAudioHeader, pcm: Uint8Array): Uint8Array {
	const out = new Uint8Array(LIVE_AUDIO_HEADER_BYTES + pcm.byteLength)
	const view = new DataView(out.buffer)
	view.setUint8(0, LIVE_PROTOCOL_VERSION)
	view.setUint8(1, header.kind)
	view.setUint16(2, 0, true)
	view.setUint32(4, header.turnIndex, true)
	view.setUint32(8, header.seq, true)
	out.set(pcm, LIVE_AUDIO_HEADER_BYTES)
	return out
}

export function decodeLiveAudioFrame(
	data: Uint8Array,
): { header: LiveAudioHeader; pcm: Uint8Array } | null {
	if (data.byteLength < LIVE_AUDIO_HEADER_BYTES) return null
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	if (view.getUint8(0) !== LIVE_PROTOCOL_VERSION) return null
	const kind = view.getUint8(1)
	if (kind !== LIVE_AUDIO_KIND_ASSISTANT && kind !== LIVE_AUDIO_KIND_USER) return null
	return {
		header: { kind, turnIndex: view.getUint32(4, true), seq: view.getUint32(8, true) },
		pcm: data.subarray(LIVE_AUDIO_HEADER_BYTES),
	}
}
