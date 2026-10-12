import { describe, expect, it } from 'vitest'
import {
	LIVE_AUDIO_HEADER_BYTES,
	LIVE_AUDIO_KIND_ASSISTANT,
	LIVE_AUDIO_KIND_USER,
	decodeLiveAudioFrame,
	encodeLiveAudioFrame,
	liveClientFrameSchema,
	liveServerFrameSchema,
	messageMetadataSchema,
	stripServerOwnedMetadata,
	workspaceSettingsSchema,
} from '../index'

describe('live audio frames', () => {
	it('round-trips header and payload', () => {
		const pcm = new Uint8Array([1, 2, 3, 4])
		const frame = encodeLiveAudioFrame(
			{ kind: LIVE_AUDIO_KIND_ASSISTANT, turnIndex: 7, seq: 42 },
			pcm,
		)
		expect(frame.byteLength).toBe(LIVE_AUDIO_HEADER_BYTES + 4)
		const decoded = decodeLiveAudioFrame(frame)
		expect(decoded?.header).toEqual({ kind: LIVE_AUDIO_KIND_ASSISTANT, turnIndex: 7, seq: 42 })
		expect(Array.from(decoded?.pcm ?? [])).toEqual([1, 2, 3, 4])
	})

	it('uses little-endian fields at fixed offsets', () => {
		const frame = encodeLiveAudioFrame(
			{ kind: LIVE_AUDIO_KIND_USER, turnIndex: 1, seq: 2 },
			new Uint8Array(),
		)
		expect(Array.from(frame)).toEqual([1, 2, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0])
	})

	it('rejects short frames, wrong version and unknown kinds', () => {
		expect(decodeLiveAudioFrame(new Uint8Array(5))).toBeNull()
		const bad = encodeLiveAudioFrame(
			{ kind: LIVE_AUDIO_KIND_ASSISTANT, turnIndex: 0, seq: 0 },
			new Uint8Array(),
		)
		bad[0] = 9
		expect(decodeLiveAudioFrame(bad)).toBeNull()
		const kind = encodeLiveAudioFrame(
			{ kind: LIVE_AUDIO_KIND_ASSISTANT, turnIndex: 0, seq: 0 },
			new Uint8Array(),
		)
		kind[1] = 3
		expect(decodeLiveAudioFrame(kind)).toBeNull()
	})
})

describe('live frames', () => {
	it('defaults interrupt to true on turn.text', () => {
		const frame = liveClientFrameSchema.parse({
			type: 'turn.text',
			client_turn_id: 'a',
			text: 'hi',
		})
		expect(frame.type === 'turn.text' && frame.interrupt).toBe(true)
	})

	it('rejects an unknown client frame type', () => {
		expect(liveClientFrameSchema.safeParse({ type: 'nope' }).success).toBe(false)
	})

	it('accepts a turn.finished server frame', () => {
		const r = liveServerFrameSchema.safeParse({
			type: 'turn.finished',
			turn_index: 0,
			message_id: null,
			interrupted: false,
			usage: {
				input_tokens: 1,
				output_tokens: 2,
				llm_cost_usd: 0,
				tts_characters: 0,
				tts_cost_usd: 0,
				stt_seconds: 0,
			},
			duration_ms: 10,
		})
		expect(r.success).toBe(true)
	})
})

describe('live settings and metadata', () => {
	it('keeps a settings block with openrouter key and live parseable', () => {
		const r = workspaceSettingsSchema.partial().safeParse({
			llm_keys: { openrouter: 'sk-or-x' },
			live: { persist_transcripts: false, daily_minutes_cap: 30 },
		})
		expect(r.success).toBe(true)
	})

	it('strips live markers a client tries to claim', () => {
		const stripped = stripServerOwnedMetadata({
			source: 'live',
			live_session_id: 'x',
			live: {},
			mentions: [],
		})
		expect(stripped).toEqual({ mentions: [] })
	})

	it('parses live message metadata', () => {
		const r = messageMetadataSchema.safeParse({
			source: 'live',
			live_session_id: '11111111-1111-4111-8111-111111111111',
			live: { turn_index: 0, input_mode: 'audio', interrupted: true, full_text: 'hello' },
		})
		expect(r.success).toBe(true)
	})
})
