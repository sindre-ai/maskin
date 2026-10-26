import type { Database } from '@maskin/db'
import type { InvokeTool, VoiceRealtimeTool } from '@maskin/mcp'
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
 * over that socket, through the channel logic in
 * (services/voice-session-channel.ts). Tool calls run as the agent with the
 * call's workspace. Every tool that is not read-only is held until the person
 * says yes out loud (services/voice-write-gate.ts); there is no tool allow-list,
 * attention cap, mentions refusal or bet refusal.
 */

export const VOICE_REALTIME_MODEL = 'gpt-realtime-2.1'
export const VOICE_REALTIME_VOICE = 'verse'
/** How long the server socket may stay connecting before the call runs without tools. */
export const VOICE_CONTROL_CONNECT_TIMEOUT_MS = 5000
/** Stored on voice_sessions.vendor_session_id while an offer is in flight, so only one offer is ever accepted. */
export const VOICE_OFFER_CLAIM = 'offer-in-flight'

/** How often an open server socket is pinged, so an idle proxy does not reap it mid-call. */
export const VOICE_SOCKET_PING_MS = 20_000
/** Waits before each re-open of a dropped server socket; its length is the number of attempts. */
export const VOICE_SOCKET_RECONNECT_DELAYS_MS = [250, 1000]

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
	tools: VoiceRealtimeTool[]
}

export type CreateRealtimeCallOutcome =
	| { kind: 'ok'; callId: string; answerSdp: string }
	| { kind: 'rate_limited'; retryAfterSeconds: number; vendorBody?: string }
	/** A 429 whose body says the account is out of quota or billing, not that it is going too fast. */
	| { kind: 'quota_exhausted'; vendorBody: string }
	| { kind: 'error'; status: number; body: string }

/** Test seam: contract tests drive every branch without reaching OpenAI. */
export type CreateRealtimeCallFn = (
	input: CreateRealtimeCallInput,
) => Promise<CreateRealtimeCallOutcome>

/**
 * OpenAI sends insufficient_quota (or billing_hard_limit_reached) on a 429 that waiting will not fix.
 * A bare "billing" match is too wide: plain free-tier rate limits link to the billing page.
 */
export function isQuotaBody(body: string): boolean {
	return /insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(body)
}

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
				// gpt-transcribe, not whisper-1: whisper-1 invents phrases ("Thank you
				// for watching") on near-silence, and each one was saved as a message
				// the user never said.
				transcription: { model: 'gpt-transcribe' },
				// Filters the mic audio before voice detection and the model see it, so
				// room noise stops registering as speech. far_field suits laptop mics;
				// near_field is for headsets.
				noise_reduction: { type: 'far_field' },
				// The API default (server_vad, 0.5 threshold, 200ms of silence) cut a new
				// turn, and so a new chat message, at every short pause. semantic_vad
				// judges whether the sentence is finished; 'low' waits longest for the
				// speaker to carry on.
				turn_detection: { type: 'semantic_vad', eagerness: 'low' },
			},
			output: { voice: input.voice },
		},
		// Every MCP tool chat has, read from the server (see createVoiceToolkit).
		tools: input.tools,
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
		const vendorBody = await res.text().catch(() => '')
		if (isQuotaBody(vendorBody)) return { kind: 'quota_exhausted', vendorBody }
		const parsed = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
		return {
			kind: 'rate_limited',
			retryAfterSeconds: Number.isFinite(parsed) && parsed > 0 ? parsed : 30,
			vendorBody,
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
	/** Optional keepalive; sockets without it (test fakes) are simply not pinged. */
	ping?(): void
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
		ping: () => ws.ping(),
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
	/** Tools that only read; every other tool waits for the person's yes. */
	readOnlyTools: ReadonlySet<string>
	/** Releases what the call's tools hold open (connections to the agent's MCP servers). */
	dispose?: () => Promise<void> | void
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
	item_id?: string
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
 * model waiting on tool results that can no longer arrive; before giving up
 * it re-opens the socket (the person's audio runs on a separate WebRTC
 * connection and is usually fine), keeping the call's gate, pending holds and
 * counters, which belong to the call and not to the socket.
 */
export function attachVoiceCall(input: AttachVoiceCallInput): Promise<boolean> {
	const { db, session } = input
	const now = input.now ?? Date.now
	const openSocket = input.openSocket ?? openSocketFn
	const url = realtimeSocketUrl(input.callId, input.callsUrl)

	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		Promise.resolve(input.dispose?.()).catch(() => {})
	}

	let socket: RealtimeSocket | null = null
	let opened = false
	let closedByUs = false
	let ended = false
	// Bumped per socket so late events from a replaced socket are ignored.
	let generation = 0
	let pingTimer: ReturnType<typeof setInterval> | null = null
	// Events for the model produced while the socket is down (tool results);
	// delivered once it is back, dropped if the call ends instead.
	const outbox: string[] = []
	// Tool calls received and not yet answered. Parallel calls in one response
	// each get their own output.
	let pendingCalls = 0
	// True once the response that asked for the tools has finished (response.done).
	// The model is only asked to speak when that has happened AND every call is
	// answered: tools finish in milliseconds, so answering the first call used to
	// fire response.create while the model was still streaming the rest of its
	// calls, which OpenAI rejects (conversation_already_has_active_response) and
	// leaves the model answering from a partial set of results.
	let toolResponseDone = false
	let turnIndex = 0
	let userSpeechStartedAt: number | null = null
	let userAudioMs = 0
	let agentResponseStartedAt: number | null = null
	let bargeIn = false

	function sendToModel(event: unknown) {
		if (!socket) {
			if (opened && !ended && outbox.length < 50) outbox.push(JSON.stringify(event))
			return
		}
		try {
			socket.send(JSON.stringify(event))
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
			askModelToSpeakIfReady()
		}
	}

	function askModelToSpeakIfReady() {
		if (!toolResponseDone || pendingCalls > 0) return
		toolResponseDone = false
		sendToModel({ type: 'response.create' })
	}

	const channel = createVoiceChannel({
		db,
		session,
		agentName: input.agentName,
		invokeTool: input.invokeTool,
		isReadOnlyTool: (name) => input.readOnlyTools.has(name),
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
				if (text) feed({ type: 'transcript', role: 'user', text, item_id: evt.item_id })
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
				feed({ type: 'user_speech_started', item_id: evt.item_id })
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
				if (evt.response?.output?.some((item) => item.type === 'function_call')) {
					toolResponseDone = true
					askModelToSpeakIfReady()
					return
				}
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

	function stopPing() {
		if (pingTimer) clearInterval(pingTimer)
		pingTimer = null
	}

	function startPing() {
		stopPing()
		pingTimer = setInterval(() => {
			try {
				socket?.ping?.()
			} catch {
				// A dead socket reports itself through onClose.
			}
		}, VOICE_SOCKET_PING_MS)
		pingTimer.unref?.()
	}

	function registerLive() {
		liveCalls.set(session.id, {
			close: () => {
				dispose()
				closedByUs = true
				stopPing()
				socket?.close()
			},
		})
	}

	/** Gives up on the call's server socket: ends the call, which hangs it up at OpenAI. */
	function endCallAfterDrop(detail: string) {
		if (ended) return
		ended = true
		outbox.length = 0
		stopPing()
		dispose()
		liveCalls.delete(session.id)
		logger.warn('Voice server socket dropped mid-call; ending the call', {
			voice_session_id: session.id,
			detail,
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
	}

	function reconnect(attempt: number) {
		const delay = VOICE_SOCKET_RECONNECT_DELAYS_MS[attempt]
		if (delay === undefined) {
			endCallAfterDrop(`reconnect failed after ${attempt} attempts`)
			return
		}
		setTimeout(() => {
			if (closedByUs || ended) return
			const myGen = ++generation
			let settled = false
			const next: { socket?: RealtimeSocket } = {}
			const failAttempt = (reason: string) => {
				if (settled || myGen !== generation) return
				settled = true
				clearTimeout(timeout)
				logger.warn('Voice server socket reconnect failed', {
					voice_session_id: session.id,
					attempt: attempt + 1,
					reason,
				})
				try {
					next.socket?.close()
				} catch {
					// Already closed.
				}
				reconnect(attempt + 1)
			}
			const timeout = setTimeout(
				() => failAttempt('connect timeout'),
				input.connectTimeoutMs ?? VOICE_CONTROL_CONNECT_TIMEOUT_MS,
			)
			next.socket = openSocket(url, input.apiKey, {
				onOpen: () => {
					if (settled || myGen !== generation) return
					settled = true
					clearTimeout(timeout)
					if (closedByUs || ended) {
						next.socket?.close()
						return
					}
					socket = next.socket ?? null
					logger.info('Voice server socket reconnected', {
						voice_session_id: session.id,
						attempt: attempt + 1,
					})
					const queued = outbox.splice(0)
					for (const raw of queued) {
						try {
							next.socket?.send(raw)
						} catch {
							// Lost with the socket; the next close handles it.
						}
					}
					startPing()
				},
				onMessage: (data) => onSocketMessage(myGen, data),
				onClose: () => {
					if (!settled) failAttempt('closed before open')
					else onSocketClosed(myGen)
				},
				onError: (err) => {
					if (!settled) failAttempt(err.message)
					else logSocketError(err)
				},
			})
		}, delay)
	}

	function onSocketMessage(myGen: number, data: string) {
		if (myGen !== generation) return
		let evt: RealtimeEvent
		try {
			evt = JSON.parse(data)
		} catch {
			return
		}
		handleEvent(evt)
	}

	function onSocketClosed(myGen: number) {
		if (myGen !== generation || ended) return
		if (closedByUs) {
			dispose()
			return
		}
		socket = null
		stopPing()
		logger.warn('Voice server socket dropped mid-call; reconnecting', {
			voice_session_id: session.id,
			pending_tool_calls: pendingCalls,
		})
		reconnect(0)
	}

	function logSocketError(err: Error) {
		logger.warn('Voice server socket error', {
			voice_session_id: session.id,
			error: err.message,
		})
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
			dispose()
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

		const myGen = ++generation
		socket = openSocket(url, input.apiKey, {
			onOpen: () => {
				if (settled) return
				opened = true
				registerLive()
				startPing()
				settle(true)
			},
			onMessage: (data) => onSocketMessage(myGen, data),
			onClose: () => {
				if (!opened) {
					if (!settled) fail('closed before open')
					return
				}
				onSocketClosed(myGen)
			},
			onError: (err) => {
				if (!opened && !settled) {
					fail(err.message)
					return
				}
				logSocketError(err)
			},
		})
	})
}
