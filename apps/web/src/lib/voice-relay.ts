/**
 * Browser half of the voice tool round-trip (tech spec §Tool + KB parity with
 * chat). Sits between the OpenAI Realtime DataChannel and the Maskin per-session
 * WebSocket (GET /api/voice-sessions/:id/events, wire protocol documented in
 * apps/dev/src/services/voice-session-channel.ts):
 *
 *   Realtime function_call_arguments.done  → ws tool_call
 *   ws tool_result.event                   → DataChannel conversation.item.create
 *                                            (function_call_output) + response.create
 *   Realtime transcript events             → ws transcript
 *   Realtime response.done                 → ws turn_completed
 *
 * Kept free of React so it can be driven directly in tests.
 */

export interface VoiceTranscriptLine {
	id: number
	kind: 'user' | 'assistant' | 'tool'
	text: string
}

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
	onopen: ((ev: unknown) => void) | null
	onmessage: ((ev: { data: unknown }) => void) | null
	onclose: ((ev: unknown) => void) | null
	onerror: ((ev: unknown) => void) | null
}

type ChannelLike = Pick<RTCDataChannel, 'send' | 'readyState'>

export interface VoiceRelayOptions {
	url: string
	channel: ChannelLike
	openSocket?: (url: string) => SocketLike
	now?: () => number
	onConversation?: (conversationId: string) => void
	onReady?: (info: { persistTranscripts: boolean; conversationId: string | null }) => void
	onLine?: (line: VoiceTranscriptLine) => void
}

export interface VoiceRelay {
	/** Feed every parsed Realtime DataChannel event through here. */
	handleRealtimeEvent: (evt: RealtimeEvent) => void
	close: () => void
}

export interface RealtimeEvent {
	type?: string
	call_id?: string
	name?: string
	arguments?: string
	transcript?: string
	response?: { output?: Array<{ type?: string }> }
}

const WS_OPEN = 1

/** The https? URL of the API → the ws(s) URL of a session's control channel. */
export function buildVoiceEventsUrl(
	voiceSessionId: string,
	apiBase: string,
	origin: string = window.location.origin,
): string {
	const url = new URL(
		`${apiBase}/voice-sessions/${encodeURIComponent(voiceSessionId)}/events`,
		origin,
	)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return url.toString()
}

/** Short mono tag for the transcript pane while a tool runs. */
export function describeToolCall(name: string, rawArguments: string | undefined): string {
	if (name === 'search_objects') {
		try {
			const query = (JSON.parse(rawArguments || '{}') as { query?: unknown }).query
			if (typeof query === 'string' && query.trim()) return `searching for ${query.trim()}…`
		} catch {
			// Fall through to the generic tag.
		}
	}
	return `running ${name}…`
}

export function createVoiceRelay(options: VoiceRelayOptions): VoiceRelay {
	const { channel, onConversation, onReady, onLine } = options
	const now = options.now ?? Date.now
	const socket = (options.openSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(
		options.url,
	)

	let lineId = 0
	let turnIndex = 0
	let userSpeechStartedAt: number | null = null
	let userAudioMs = 0
	let agentResponseStartedAt: number | null = null
	let bargeIn = false
	let socketFailed = false
	// Tool calls sent before the socket opened, replayed on open.
	const pendingFrames: string[] = []
	// Calls forwarded and not yet answered; failed back to the model if the
	// socket dies so the agent can say so instead of hanging.
	const unanswered = new Map<string, string>()

	function addLine(kind: VoiceTranscriptLine['kind'], text: string) {
		lineId += 1
		onLine?.({ id: lineId, kind, text })
	}

	function sendToModel(event: unknown) {
		if (channel.readyState !== 'open') return
		channel.send(JSON.stringify(event))
	}

	function answerToModel(callId: string, output: string) {
		sendToModel({
			type: 'conversation.item.create',
			item: { type: 'function_call_output', call_id: callId, output },
		})
		sendToModel({ type: 'response.create' })
	}

	function sendFrame(frame: unknown) {
		const raw = JSON.stringify(frame)
		if (socket.readyState === WS_OPEN) socket.send(raw)
		else pendingFrames.push(raw)
	}

	function failUnanswered() {
		for (const [callId] of unanswered) {
			answerToModel(
				callId,
				JSON.stringify({
					error: 'Tools are unavailable on this call right now.',
					error_code: 'voice_channel_unavailable',
				}),
			)
		}
		unanswered.clear()
	}

	socket.onopen = () => {
		for (const raw of pendingFrames.splice(0)) socket.send(raw)
	}
	socket.onmessage = (ev) => {
		if (typeof ev.data !== 'string') return
		let msg: {
			type?: string
			call_id?: string
			event?: unknown
			persist_transcripts?: boolean
			conversation_id?: string | null
		}
		try {
			msg = JSON.parse(ev.data)
		} catch {
			return
		}
		if (msg.type === 'tool_result' && msg.call_id) {
			unanswered.delete(msg.call_id)
			sendToModel(msg.event)
			sendToModel({ type: 'response.create' })
		} else if (msg.type === 'ready') {
			onReady?.({
				persistTranscripts: msg.persist_transcripts === true,
				conversationId: msg.conversation_id ?? null,
			})
			if (msg.conversation_id) onConversation?.(msg.conversation_id)
		} else if (msg.type === 'conversation' && msg.conversation_id) {
			onConversation?.(msg.conversation_id)
		}
	}
	const onSocketDead = () => {
		socketFailed = true
		pendingFrames.length = 0
		failUnanswered()
	}
	socket.onclose = onSocketDead
	socket.onerror = onSocketDead

	return {
		handleRealtimeEvent(evt) {
			switch (evt.type) {
				case 'response.function_call_arguments.done': {
					if (!evt.call_id || !evt.name) return
					addLine('tool', describeToolCall(evt.name, evt.arguments))
					if (socketFailed) {
						answerToModel(
							evt.call_id,
							JSON.stringify({
								error: 'Tools are unavailable on this call right now.',
								error_code: 'voice_channel_unavailable',
							}),
						)
						return
					}
					unanswered.set(evt.call_id, evt.name)
					sendFrame({
						type: 'tool_call',
						call_id: evt.call_id,
						name: evt.name,
						arguments: evt.arguments ?? '{}',
					})
					return
				}
				case 'conversation.item.input_audio_transcription.completed': {
					const text = evt.transcript?.trim()
					if (!text) return
					addLine('user', text)
					sendFrame({ type: 'transcript', role: 'user', text })
					return
				}
				case 'response.audio_transcript.done': {
					const text = evt.transcript?.trim()
					if (!text) return
					addLine('assistant', text)
					sendFrame({ type: 'transcript', role: 'assistant', text })
					return
				}
				case 'input_audio_buffer.speech_started':
					userSpeechStartedAt = now()
					// Speaking over an agent that is mid-response is a barge-in.
					if (agentResponseStartedAt !== null) bargeIn = true
					return
				case 'input_audio_buffer.speech_stopped':
					if (userSpeechStartedAt !== null) userAudioMs += now() - userSpeechStartedAt
					userSpeechStartedAt = null
					return
				case 'response.created':
					agentResponseStartedAt = now()
					return
				case 'response.done': {
					const startedAt = agentResponseStartedAt
					agentResponseStartedAt = null
					// A response that only asked for a tool is the middle of a turn, not
					// the end: the spoken answer follows the tool result.
					if (evt.response?.output?.some((item) => item.type === 'function_call')) return
					sendFrame({
						type: 'turn_completed',
						turn_index: turnIndex,
						user_audio_ms: Math.round(userAudioMs),
						agent_audio_ms: startedAt === null ? 0 : Math.round(now() - startedAt),
						barge_in: bargeIn,
					})
					turnIndex += 1
					userAudioMs = 0
					bargeIn = false
					return
				}
			}
		},
		close() {
			try {
				socket.close()
			} catch {
				// Already closed.
			}
		},
	}
}
