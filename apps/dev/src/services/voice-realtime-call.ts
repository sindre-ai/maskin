import type { Database } from '@maskin/db'
import { VOICE_REALTIME_TOOLS } from '@maskin/mcp'
import type { InvokeTool } from '@maskin/mcp'
import WebSocket from 'ws'
import { logger } from '../lib/logger'
import { captureVoiceException } from '../lib/sentry-voice'
import { type VoiceServerMessage, createVoiceChannel } from './voice-session-channel'
import { endVoiceSession } from './voice-session-lifecycle'
import type { VoiceSessionRow } from './voice-transcript'

/**
 * Server half of a voice call's live connection (OpenAI Realtime GA, "unified
 * interface"). The browser keeps the audio path (WebRTC to OpenAI) but never
 * holds a credential: it hands its SDP offer to our authenticated route, which
 * posts it to POST /v1/realtime/calls with the operator key, then attaches a
 * server-side WebSocket to the new call (wss://.../v1/realtime?call_id=...)
 * with the same key. Tool calls, transcript lines and turn telemetry all run
 * over that socket, through the same channel logic the whitelist, attention
 * cap, mentions refusal and bet refusal already live in
 * (services/voice-session-channel.ts).
 */

export const VOICE_REALTIME_MODEL = 'gpt-realtime-2.1'
export const VOICE_REALTIME_VOICE = 'verse'
/** How long the server socket may stay connecting before the call runs without tools. */
export const VOICE_CONTROL_CONNECT_TIMEOUT_MS = 5000
/** Stored on voice_sessions.vendor_session_id while an offer is in flight, so only one offer is ever accepted. */
export const VOICE_OFFER_CLAIM = 'offer-in-flight'

const DEFAULT_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

/** MASKIN_VOICE_OPENAI_REALTIME_URL, when set, replaces the calls endpoint (used to point at a fake in tests and staging). */
export function realtimeCallsUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env.MASKIN_VOICE_OPENAI_REALTIME_URL?.trim() || DEFAULT_CALLS_URL
}

/** https://host/v1/realtime/calls → wss://host/v1/realtime?call_id=... */
export function realtimeSocketUrl(callId: string, callsUrl: string = realtimeCallsUrl()): string {
	const url = new URL(callsUrl)
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
	url.pathname = url.pathname.replace(/\/calls\/?$/, '')
	url.search = `?call_id=${encodeURIComponent(callId)}`
	return url.toString()
}

// ── Create the call ──────────────────────────────────────────────────

export interface CreateRealtimeCallInput {
	apiKey: string
	callsUrl: string
	offerSdp: string
	instructions: string
	voice: string
	model: string
}

export type CreateRealtimeCallOutcome =
	| { kind: 'ok'; callId: string; answerSdp: string }
	| { kind: 'rate_limited'; retryAfterSeconds: number }
	| { kind: 'error'; status: number; body: string }

/** Test seam: contract tests drive every branch without reaching OpenAI. */
export type CreateRealtimeCallFn = (
	input: CreateRealtimeCallInput,
) => Promise<CreateRealtimeCallOutcome>

async function defaultCreateRealtimeCall(
	input: CreateRealtimeCallInput,
): Promise<CreateRealtimeCallOutcome> {
	const session = {
		type: 'realtime',
		model: input.model,
		instructions: input.instructions,
		audio: {
			input: {
				// Without this the session never emits user-turn transcripts, so
				// there is nothing to persist for the user's side of the call.
				transcription: { model: 'whisper-1' },
				turn_detection: { type: 'server_vad' },
			},
			output: { voice: input.voice },
		},
		// The v1 whitelist, pinned here (tech spec §Auth flow step 3). The channel
		// re-enforces it per call, so this list and the gate share one source:
		// @maskin/mcp.
		tools: VOICE_REALTIME_TOOLS,
		tool_choice: 'auto',
	}
	const form = new FormData()
	form.set('sdp', input.offerSdp)
	form.set('session', JSON.stringify(session))

	let res: Response
	try {
		res = await fetch(input.callsUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${input.apiKey}` },
			body: form,
		})
	} catch (err) {
		return { kind: 'error', status: 502, body: err instanceof Error ? err.message : String(err) }
	}
	if (res.status === 429) {
		const parsed = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
		return {
			kind: 'rate_limited',
			retryAfterSeconds: Number.isFinite(parsed) && parsed > 0 ? parsed : 30,
		}
	}
	if (!res.ok) {
		return { kind: 'error', status: res.status, body: await res.text().catch(() => '') }
	}
	// The call id is only in the Location header (/v1/realtime/calls/rtc_...).
	const callId = res.headers.get('location')?.split('/').filter(Boolean).pop()
	const answerSdp = await res.text().catch(() => '')
	if (!callId || !answerSdp) {
		return { kind: 'error', status: 502, body: 'Realtime response missing Location or SDP answer' }
	}
	return { kind: 'ok', callId, answerSdp }
}

let createRealtimeCallFn: CreateRealtimeCallFn = defaultCreateRealtimeCall

export function setCreateRealtimeCallFn(fn: CreateRealtimeCallFn | null): void {
	createRealtimeCallFn = fn ?? defaultCreateRealtimeCall
}

export function createRealtimeCall(
	input: CreateRealtimeCallInput,
): Promise<CreateRealtimeCallOutcome> {
	return createRealtimeCallFn(input)
}

// ── Server socket ────────────────────────────────────────────────────

export interface RealtimeSocket {
	send(data: string): void
	close(): void
}

export interface RealtimeSocketHandlers {
	onOpen(): void
	onMessage(data: string): void
	onClose(): void
	onError(err: Error): void
}

export type OpenRealtimeSocketFn = (
	url: string,
	apiKey: string,
	handlers: RealtimeSocketHandlers,
) => RealtimeSocket

const defaultOpenSocket: OpenRealtimeSocketFn = (url, apiKey, handlers) => {
	const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } })
	ws.on('open', handlers.onOpen)
	ws.on('message', (data: unknown, isBinary: boolean) => {
		if (!isBinary) handlers.onMessage(String(data))
	})
	ws.on('close', handlers.onClose)
	ws.on('error', (err: Error) => handlers.onError(err))
	return {
		send: (data) => ws.send(data),
		close: () => ws.close(),
	}
}

let openSocketFn: OpenRealtimeSocketFn = defaultOpenSocket

export function setOpenRealtimeSocketFn(fn: OpenRealtimeSocketFn | null): void {
	openSocketFn = fn ?? defaultOpenSocket
}

// ── Live connections ─────────────────────────────────────────────────

// In-process, like the live counters: a call's socket lives in the one server
// process that accepted its offer.
const liveCalls = new Map<string, { close: () => void }>()

/** Tears down the server side of a call's connection and hangs the call up at OpenAI. Failures are logged, never thrown. */
export async function closeVoiceCall(session: {
	voiceSessionId: string
	vendorSessionId: string | null
}): Promise<void> {
	const live = liveCalls.get(session.voiceSessionId)
	liveCalls.delete(session.voiceSessionId)
	live?.close()
	const callId = session.vendorSessionId
	if (!callId || callId === VOICE_OFFER_CLAIM) return
	try {
		const res = await fetch(`${realtimeCallsUrl()}/${encodeURIComponent(callId)}/hangup`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${process.env.MASKIN_VOICE_OPENAI_API_KEY ?? ''}` },
		})
		// A call the browser already closed answers 4xx; that is the expected race.
		if (!res.ok) {
			logger.debug('Voice vendor call hangup not accepted', {
				voice_session_id: session.voiceSessionId,
				status: res.status,
			})
		}
	} catch (err) {
		logger.warn('Voice vendor call hangup failed', {
			voice_session_id: session.voiceSessionId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

// ── Attach ───────────────────────────────────────────────────────────

export interface AttachVoiceCallInput {
	db: Database
	session: VoiceSessionRow
	agentName: string
	invokeTool: InvokeTool
	callId: string
	apiKey: string
	callsUrl?: string
	connectTimeoutMs?: number
	openSocket?: OpenRealtimeSocketFn
	now?: () => number
}

interface RealtimeEvent {
	type?: string
	call_id?: string
	name?: string
	arguments?: string
	transcript?: string
	response?: { output?: Array<{ type?: string }> }
	error?: { code?: string; message?: string }
}

/**
 * Opens the server socket on a freshly created call and wires it to the voice
 * channel. Resolves true once the socket is open (tools available), false if
 * it did not open within the timeout or failed: the caller then tells the
 * browser, which answers every tool call with "tools are unavailable" so the
 * agent says so instead of waiting on a call nobody runs. Once open, a socket
 * that drops ends the call (and hangs it up at OpenAI) rather than leaving the
 * model waiting on tool results that can no longer arrive.
 */
export function attachVoiceCall(input: AttachVoiceCallInput): Promise<boolean> {
	const { db, session } = input
	const now = input.now ?? Date.now
	const openSocket = input.openSocket ?? openSocketFn
	const url = realtimeSocketUrl(input.callId, input.callsUrl)

	let socket: RealtimeSocket | null = null
	let opened = false
	let closedByUs = false
	// Tool calls received and not yet answered. Parallel calls in one response
	// each get their own output, and the model is only asked to speak once the
	// last one is in (a response.create while a response is active is an error).
	let pendingCalls = 0
	let turnIndex = 0
	let userSpeechStartedAt: number | null = null
	let userAudioMs = 0
	let agentResponseStartedAt: number | null = null
	let bargeIn = false

	function sendToModel(event: unknown) {
		try {
			socket?.send(JSON.stringify(event))
		} catch (err) {
			logger.warn('Voice server socket send failed', {
				voice_session_id: session.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	function onChannelMessage(message: VoiceServerMessage) {
		if (message.type === 'tool_result') {
			pendingCalls = Math.max(0, pendingCalls - 1)
			sendToModel(message.event)
			if (pendingCalls === 0) sendToModel({ type: 'response.create' })
		}
	}

	const channel = createVoiceChannel({
		db,
		session,
		agentName: input.agentName,
		invokeTool: input.invokeTool,
		send: onChannelMessage,
		now,
	})

	function feed(frame: unknown) {
		channel.onMessage(JSON.stringify(frame)).catch((err) =>
			logger.error('Voice channel message failed', {
				voice_session_id: session.id,
				error: String(err),
			}),
		)
	}

	function handleEvent(evt: RealtimeEvent) {
		switch (evt.type) {
			case 'response.function_call_arguments.done':
				if (!evt.call_id || !evt.name) return
				pendingCalls += 1
				feed({
					type: 'tool_call',
					call_id: evt.call_id,
					name: evt.name,
					arguments: evt.arguments ?? '{}',
				})
				return
			case 'conversation.item.input_audio_transcription.completed': {
				const text = evt.transcript?.trim()
				if (text) feed({ type: 'transcript', role: 'user', text })
				return
			}
			// GA name first; the beta name is kept so a fake or older edge still works.
			case 'response.output_audio_transcript.done':
			case 'response.audio_transcript.done': {
				const text = evt.transcript?.trim()
				if (text) feed({ type: 'transcript', role: 'assistant', text })
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
				feed({
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
			case 'error':
				// Not fatal by itself (a rejected client event is also an error); a
				// call the vendor really gave up on closes the socket.
				logger.warn('Voice vendor error event', {
					voice_session_id: session.id,
					vendor_error_code: evt.error?.code ?? 'unknown',
				})
				return
		}
	}

	return new Promise<boolean>((resolve) => {
		let settled = false
		const settle = (ok: boolean) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(ok)
		}
		const fail = (reason: string) => {
			closedByUs = true
			try {
				socket?.close()
			} catch {
				// Already closed.
			}
			logger.warn('Voice server socket did not attach; call continues without tools', {
				voice_session_id: session.id,
				reason,
			})
			captureVoiceException(session.id, new Error(`Voice server socket: ${reason}`))
			settle(false)
		}
		const timer = setTimeout(
			() => fail('connect timeout'),
			input.connectTimeoutMs ?? VOICE_CONTROL_CONNECT_TIMEOUT_MS,
		)

		socket = openSocket(url, input.apiKey, {
			onOpen: () => {
				if (settled) return
				opened = true
				liveCalls.set(session.id, {
					close: () => {
						closedByUs = true
						socket?.close()
					},
				})
				settle(true)
			},
			onMessage: (data) => {
				let evt: RealtimeEvent
				try {
					evt = JSON.parse(data)
				} catch {
					return
				}
				handleEvent(evt)
			},
			onClose: () => {
				if (!opened) {
					if (!settled) fail('closed before open')
					return
				}
				if (closedByUs) return
				liveCalls.delete(session.id)
				logger.warn('Voice server socket dropped mid-call; ending the call', {
					voice_session_id: session.id,
				})
				// endVoiceSession hangs the call up at OpenAI through closeVoiceCall, so
				// the browser's connection closes and its own recovery path takes over.
				endVoiceSession(db, { id: session.id, reason: 'network_error' }).catch((err) => {
					logger.error('Voice call end after socket drop failed', {
						voice_session_id: session.id,
						error: err instanceof Error ? err.message : String(err),
					})
					captureVoiceException(session.id, err)
				})
			},
			onError: (err) => {
				if (!opened && !settled) {
					fail(err.message)
					return
				}
				logger.warn('Voice server socket error', {
					voice_session_id: session.id,
					error: err.message,
				})
			},
		})
	})
}
