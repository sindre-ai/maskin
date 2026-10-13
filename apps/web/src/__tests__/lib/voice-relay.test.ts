import { type VoiceTranscriptLine, createVoiceRelay, describeToolCall } from '@/lib/voice-relay'
import { describe, expect, it } from 'vitest'

function setup(opts: { toolsAvailable?: boolean; channelOpen?: boolean } = {}) {
	const channel = {
		readyState: (opts.channelOpen === false ? 'closed' : 'open') as RTCDataChannelState,
		sent: [] as string[],
		send(raw: string) {
			this.sent.push(raw)
		},
	}
	const lines: VoiceTranscriptLine[] = []
	const relay = createVoiceRelay({
		channel: channel as never,
		toolsAvailable: opts.toolsAvailable ?? true,
		onLine: (l) => lines.push(l),
	})
	return { channel, relay, lines, toModel: () => channel.sent.map((s) => JSON.parse(s)) }
}

const searchCall = {
	type: 'response.function_call_arguments.done',
	call_id: 'c1',
	name: 'search_objects',
	arguments: '{"q":"loops v4 bet"}',
}

describe('describeToolCall', () => {
	it('tags a search with its query and anything else generically', () => {
		expect(describeToolCall('search_objects', '{"q":"loops v4 bet"}')).toBe(
			'searching for loops v4 bet…',
		)
		expect(describeToolCall('search_objects', 'not json')).toBe('running search_objects…')
		expect(describeToolCall('get_objects', '{}')).toBe('running get_objects…')
	})
})

describe('voice relay: tool calls', () => {
	it('tags the transcript pane and leaves the answer to the server when tools are available', () => {
		const h = setup()
		h.relay.handleRealtimeEvent(searchCall)
		expect(h.lines).toEqual([{ id: 1, kind: 'tool', text: 'searching for loops v4 bet…' }])
		expect(h.toModel()).toEqual([])
	})

	it('answers the call with an unavailable result when the server could not attach', () => {
		const h = setup({ toolsAvailable: false })
		h.relay.handleRealtimeEvent(searchCall)
		const [output, speak] = h.toModel()
		expect(output.type).toBe('conversation.item.create')
		expect(output.item.call_id).toBe('c1')
		expect(JSON.parse(output.item.output).error_code).toBe('voice_channel_unavailable')
		expect(speak).toEqual({ type: 'response.create' })
		expect(h.lines).toHaveLength(1)
	})

	it('sends nothing into a closed data channel', () => {
		const h = setup({ toolsAvailable: false, channelOpen: false })
		h.relay.handleRealtimeEvent(searchCall)
		expect(h.toModel()).toEqual([])
	})

	it('ignores a call event with no id or name', () => {
		const h = setup({ toolsAvailable: false })
		h.relay.handleRealtimeEvent({ type: 'response.function_call_arguments.done' })
		expect(h.lines).toEqual([])
		expect(h.toModel()).toEqual([])
	})
})

describe('voice relay: transcript lines', () => {
	it('adds finished user turns and agent turns, trimmed, under both agent event names', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: ' hello there ',
		})
		h.relay.handleRealtimeEvent({
			type: 'response.output_audio_transcript.done',
			transcript: 'Hi!',
		})
		h.relay.handleRealtimeEvent({ type: 'response.audio_transcript.done', transcript: 'Again' })
		expect(h.lines).toEqual([
			{ id: 1, kind: 'user', text: 'hello there' },
			{ id: 2, kind: 'assistant', text: 'Hi!' },
			{ id: 3, kind: 'assistant', text: 'Again' },
		])
	})

	it('skips empty transcripts', () => {
		const h = setup()
		h.relay.handleRealtimeEvent({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: '   ',
		})
		expect(h.lines).toEqual([])
	})
})
