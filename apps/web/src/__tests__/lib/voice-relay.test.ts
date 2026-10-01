import {
	type VoiceTranscriptLine,
	buildVoiceEventsUrl,
	createVoiceRelay,
	describeToolCall,
} from '@/lib/voice-relay'
import { describe, expect, it, vi } from 'vitest'

function setup(opts: { socketOpen?: boolean } = {}) {
	const socket = {
		readyState: opts.socketOpen === false ? 0 : 1,
		sent: [] as string[],
		send(raw: string) {
			this.sent.push(raw)
		},
		close: vi.fn(),
		onopen: null as ((ev: unknown) => void) | null,
		onmessage: null as ((ev: { data: unknown }) => void) | null,
		onclose: null as ((ev: unknown) => void) | null,
		onerror: null as ((ev: unknown) => void) | null,
	}
	const channel = {
		readyState: 'open' as RTCDataChannelState,
		sent: [] as string[],
		send(raw: string) {
			this.sent.push(raw)
		},
	}
	let t = 1_000
	const lines: VoiceTranscriptLine[] = []
	const onConversation = vi.fn()
	const onReady = vi.fn()
	const relay = createVoiceRelay({
		url: 'ws://x/events',
		channel: channel as never,
		openSocket: () => socket as never,
		now: () => t,
		onConversation,
		onReady,
		onLine: (l) => lines.push(l),
	})
	return {
		socket,
		channel,
		relay,
		lines,
		onConversation,
		onReady,
		advance: (ms: number) => {
			t += ms
		},
		frames: () => socket.sent.map((s) => JSON.parse(s)),
		toModel: () => channel.sent.map((s) => JSON.parse(s)),
	}
}

describe('buildVoiceEventsUrl', () => {
	it('maps http to ws and https to wss', () => {
		expect(buildVoiceEventsUrl('abc', '/api', 'http://localhost:5173')).toBe(
			'ws://localhost:5173/api/voice-sessions/abc/events',
		)
		expect(buildVoiceEventsUrl('abc', '/api', 'https://app.maskin.io')).toBe(
			'wss://app.maskin.io/api/voice-sessions/abc/events',
		)
	})
})

describe('describeToolCall', () => {
	it('tags a search with its query and anything else generically', () => {
		expect(describeToolCall('search_objects', '{"query":"loops v4 bet"}')).toBe(
			'searching for loops v4 bet…',
		)
		expect(describeToolCall('search_objects', 'not json')).toBe('running search_objects…')
		expect(describeToolCall('get_objects', '{}')).toBe('running get_objects…')
	})
})

describe('voice relay: tool round-trip', () => {
	it('forwards a function call to the socket and tags the transcript', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({
			type: 'response.function_call_arguments.done',
			call_id: 'c1',
			name: 'search_objects',
			arguments: '{"query":"loops v4 bet"}',
		})
		expect(h.frames()).toEqual([
			{
				type: 'tool_call',
				call_id: 'c1',
				name: 'search_objects',
				arguments: '{"query":"loops v4 bet"}',
			},
		])
		expect(h.lines).toEqual([{ id: 1, kind: 'tool', text: 'searching for loops v4 bet…' }])
	})

	it('relays the server result into the Realtime session and asks the model to speak', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({
			type: 'response.function_call_arguments.done',
			call_id: 'c1',
			name: 'search_objects',
			arguments: '{}',
		})
		const event = {
			type: 'conversation.item.create',
			item: { type: 'function_call_output', call_id: 'c1', output: 'top hit' },
		}
		h.socket.onmessage?.({
			data: JSON.stringify({
				type: 'tool_result',
				call_id: 'c1',
				name: 'search_objects',
				ok: true,
				event,
			}),
		})
		expect(h.toModel()).toEqual([event, { type: 'response.create' }])
	})

	it('queues frames until the socket opens', () => {
		const h = setup({ socketOpen: false })
		h.relay.handleRealtimeEvent({
			type: 'response.function_call_arguments.done',
			call_id: 'c1',
			name: 'get_objects',
			arguments: '{}',
		})
		expect(h.socket.sent).toHaveLength(0)
		h.socket.readyState = 1
		h.socket.onopen?.({})
		expect(h.frames()).toHaveLength(1)
	})

	it('answers an in-flight call with an error when the socket dies', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({
			type: 'response.function_call_arguments.done',
			call_id: 'c1',
			name: 'get_objects',
			arguments: '{}',
		})
		h.socket.onclose?.({})
		const [item, create] = h.toModel()
		expect(item.item.call_id).toBe('c1')
		expect(JSON.parse(item.item.output).error_code).toBe('voice_channel_unavailable')
		expect(create).toEqual({ type: 'response.create' })
	})

	it('answers a new call immediately once the socket has failed', () => {
		const h = setup()
		h.socket.onerror?.({})
		h.relay.handleRealtimeEvent({
			type: 'response.function_call_arguments.done',
			call_id: 'c2',
			name: 'get_objects',
			arguments: '{}',
		})
		expect(h.frames()).toHaveLength(0)
		expect(h.toModel()[0].item.call_id).toBe('c2')
	})
})

describe('voice relay: control messages', () => {
	it('reports ready and conversation ids', () => {
		const h = setup()
		h.socket.onmessage?.({
			data: JSON.stringify({ type: 'ready', persist_transcripts: true, conversation_id: null }),
		})
		expect(h.onReady).toHaveBeenCalledWith({ persistTranscripts: true, conversationId: null })
		expect(h.onConversation).not.toHaveBeenCalled()
		h.socket.onmessage?.({
			data: JSON.stringify({ type: 'conversation', conversation_id: 'conv-1' }),
		})
		expect(h.onConversation).toHaveBeenCalledWith('conv-1')
	})

	it('ignores malformed and binary frames', () => {
		const h = setup()
		h.socket.onmessage?.({ data: 'nope' })
		h.socket.onmessage?.({ data: new ArrayBuffer(2) })
		expect(h.onReady).not.toHaveBeenCalled()
	})
})

describe('voice relay: transcripts and turns', () => {
	it('sends user and assistant transcript lines, trimmed, skipping empties', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: ' hello \n',
		})
		h.relay.handleRealtimeEvent({ type: 'response.audio_transcript.done', transcript: 'Hi there' })
		h.relay.handleRealtimeEvent({ type: 'response.audio_transcript.done', transcript: '  ' })
		expect(h.frames()).toEqual([
			{ type: 'transcript', role: 'user', text: 'hello' },
			{ type: 'transcript', role: 'assistant', text: 'Hi there' },
		])
		expect(h.lines.map((l) => l.kind)).toEqual(['user', 'assistant'])
	})

	it('emits turn_completed with audio durations and increments turn_index', () => {
		const h = setup()
		const ev = (type: string) => h.relay.handleRealtimeEvent({ type })
		ev('input_audio_buffer.speech_started')
		h.advance(1_500)
		ev('input_audio_buffer.speech_stopped')
		ev('response.created')
		h.advance(4_000)
		ev('response.done')
		ev('response.created')
		h.advance(1_000)
		ev('response.done')
		expect(h.frames()).toEqual([
			{
				type: 'turn_completed',
				turn_index: 0,
				user_audio_ms: 1500,
				agent_audio_ms: 4000,
				barge_in: false,
			},
			{
				type: 'turn_completed',
				turn_index: 1,
				user_audio_ms: 0,
				agent_audio_ms: 1000,
				barge_in: false,
			},
		])
	})

	it('flags barge_in when the user speaks over an in-flight response', () => {
		const h = setup()
		const ev = (type: string) => h.relay.handleRealtimeEvent({ type })
		ev('response.created')
		h.advance(800)
		ev('input_audio_buffer.speech_started')
		h.advance(600)
		ev('input_audio_buffer.speech_stopped')
		ev('response.done')
		expect(h.frames()[0]).toMatchObject({ barge_in: true, user_audio_ms: 600 })
	})

	it('does not end the turn on a response that only requested a tool', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({ type: 'response.created' })
		h.relay.handleRealtimeEvent({
			type: 'response.done',
			response: { output: [{ type: 'function_call' }] },
		})
		expect(h.frames()).toHaveLength(0)
	})
})
