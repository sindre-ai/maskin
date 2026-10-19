/**
 * Browser half of the voice tool round-trip. The tools themselves run on the
 * server: it holds its own connection to the call (see
 * apps/dev/src/services/voice-realtime-call.ts) and answers the model directly,
 * so the browser holds no credential for them and opens no socket.
 *
 * What is left here, fed from the Realtime DataChannel:
 *
 *   function_call_arguments.done  → a tool tag in the transcript pane; when the
 *                                   server could not attach its connection, an
 *                                   "unavailable" answer so the agent says so
 *                                   instead of waiting on a call nobody runs
 *   finished user / agent turns   → lines in the transcript pane
 *
 * Kept free of React so it can be driven directly in tests.
 */

export interface VoiceTranscriptLine {
	id: number
	kind: 'user' | 'assistant' | 'tool'
	text: string
}

type ChannelLike = Pick<RTCDataChannel, 'send' | 'readyState'>

export interface VoiceRelayOptions {
	channel: ChannelLike
	/** False when the offer response said the server could not attach its tool connection. */
	toolsAvailable: boolean
	onLine?: (line: VoiceTranscriptLine) => void
}

export interface VoiceRelay {
	/** Feed every parsed Realtime DataChannel event through here. */
	handleRealtimeEvent: (evt: RealtimeEvent) => void
}

export interface RealtimeEvent {
	type?: string
	call_id?: string
	name?: string
	arguments?: string
	transcript?: string
}

/** Short mono tag for the transcript pane while a tool runs. */
export function describeToolCall(name: string, rawArguments: string | undefined): string {
	if (name === 'search_objects') {
		try {
			const args = JSON.parse(rawArguments || '{}') as { q?: unknown; query?: unknown }
			const query = args.q ?? args.query
			if (typeof query === 'string' && query.trim()) return `searching for ${query.trim()}…`
		} catch {
			// Fall through to the generic tag.
		}
	}
	return `running ${name}…`
}

export function createVoiceRelay(options: VoiceRelayOptions): VoiceRelay {
	const { channel, toolsAvailable, onLine } = options
	let lineId = 0

	function addLine(kind: VoiceTranscriptLine['kind'], text: string) {
		lineId += 1
		onLine?.({ id: lineId, kind, text })
	}

	function sendToModel(event: unknown) {
		if (channel.readyState !== 'open') return
		channel.send(JSON.stringify(event))
	}

	return {
		handleRealtimeEvent(evt) {
			switch (evt.type) {
				case 'response.function_call_arguments.done': {
					if (!evt.call_id || !evt.name) return
					addLine('tool', describeToolCall(evt.name, evt.arguments))
					if (toolsAvailable) return
					sendToModel({
						type: 'conversation.item.create',
						item: {
							type: 'function_call_output',
							call_id: evt.call_id,
							output: JSON.stringify({
								error: 'Tools are unavailable on this call right now.',
								error_code: 'voice_channel_unavailable',
							}),
						},
					})
					sendToModel({ type: 'response.create' })
					return
				}
				case 'conversation.item.input_audio_transcription.completed': {
					const text = evt.transcript?.trim()
					if (text) addLine('user', text)
					return
				}
				// GA name first; the beta name is kept for an older edge.
				case 'response.output_audio_transcript.done':
				case 'response.audio_transcript.done': {
					const text = evt.transcript?.trim()
					if (text) addLine('assistant', text)
					return
				}
			}
		},
	}
}
