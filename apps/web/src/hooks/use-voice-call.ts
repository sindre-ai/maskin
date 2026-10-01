import { ApiError, api } from '@/lib/api'
import { API_BASE } from '@/lib/constants'
import { VOICE_UNAVAILABLE_TOOLTIP, markVoiceUnavailable } from '@/lib/voice-availability'
import {
	type VoiceRelay,
	type VoiceTranscriptLine,
	buildVoiceEventsUrl,
	createVoiceRelay,
} from '@/lib/voice-relay'
import { showVoiceCallEndedToast } from '@/lib/voice-toast'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

// The primary states from the Voice v1 design SPEC, plus its two microphone
// error states. Anything the SPEC calls a "Live (…)" state maps here so the
// dialog can key its render off a single string.
export type VoiceCallState =
	| 'permission'
	| 'mic-blocked'
	| 'no-mic'
	| 'connecting'
	| 'live-agent-speaking'
	| 'live-user-speaking'
	| 'live-agent-thinking'
	| 'live-muted'
	| 'reconnecting'

export interface VoiceCall {
	state: VoiceCallState
	/** Non-fatal message surfaced under the primary control on the Permission
	 *  screen (mint failed, handshake failed, connection dropped). Microphone
	 *  problems have their own states instead. */
	notice: string | null
	transcriptOpen: boolean
	/** Finished turns plus tool-in-flight tags, in order, for the transcript pane. */
	transcriptLines: VoiceTranscriptLine[]
	/** Kick off the WebRTC handshake — call this from the Permission screen's
	 *  Allow button. Requests the mic, mints a Realtime session, and negotiates
	 *  SDP against the OpenAI Realtime edge. */
	start: () => Promise<void>
	/** No-mic state's Retry: re-enumerate devices, and move on to Permission
	 *  once an input exists. */
	retryMic: () => Promise<void>
	toggleMute: () => void
	toggleTranscript: () => void
	end: () => void
}

/** How long a dropped connection gets to come back before the call is ended (SPEC §Reconnecting). */
export const VOICE_RECONNECT_WINDOW_MS = 15_000

/** Browser mic failures that mean "the user said no", as opposed to "there is no mic". */
function isMicBlocked(err: unknown): boolean {
	return (
		err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
	)
}

function isMicMissing(err: unknown): boolean {
	return (
		err instanceof DOMException &&
		(err.name === 'NotFoundError' ||
			err.name === 'OverconstrainedError' ||
			err.name === 'DevicesNotFoundError')
	)
}

// The Realtime endpoint. Documented in the tech spec §Auth flow (POST to
// api.openai.com/v1/realtime with the ephemeral client_secret as bearer).
const OPENAI_REALTIME_URL = 'https://api.openai.com/v1/realtime'
const REALTIME_MODEL = 'gpt-realtime'

export function useVoiceCall(agentActorId: string, agentName: string, open: boolean): VoiceCall {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	// The toast reads these at call end. Held in a ref so finish() keeps a stable
	// identity: the mount effect below hangs up on cleanup, so a finish that
	// changed with the router's navigate would end a live call.
	const toastContextRef = useRef({ agentName, navigate })
	toastContextRef.current = { agentName, navigate }
	const [state, setState] = useState<VoiceCallState>('permission')
	const [notice, setNotice] = useState<string | null>(null)
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const [transcriptLines, setTranscriptLines] = useState<VoiceTranscriptLine[]>([])
	const mutedRef = useRef(false)
	const preMuteStateRef = useRef<VoiceCallState>('live-agent-speaking')

	// Handles held for tear-down. Everything the call owns must be releasable
	// from one place; a leaked mic track (or a leaked peer connection sitting on
	// the OpenAI edge) is silent and long-lived.
	const pcRef = useRef<RTCPeerConnection | null>(null)
	const localStreamRef = useRef<MediaStream | null>(null)
	const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
	const dataChannelRef = useRef<RTCDataChannel | null>(null)
	const relayRef = useRef<VoiceRelay | null>(null)
	// What the post-call toast needs. Set once the call is connecting, cleared
	// when finish() takes it, so the toast fires at most once per call.
	const callRef = useRef<{
		startedAt: number
		persistTranscripts: boolean | null
		conversationId: string | null
	} | null>(null)

	// Server-side call bookkeeping. The voice_sessions row stays pending / active
	// (and the caller's one-live-call slot stays taken) until a hangup lands, so
	// every way out of a minted call has to go through finish().
	const voiceSessionIdRef = useRef<string | null>(null)
	const connectedAtRef = useRef<number | null>(null)
	const agentSpeakingSinceRef = useRef<number | null>(null)
	const outputAudioMsRef = useRef(0)
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const iceRestartedRef = useRef(false)

	const clearReconnectTimer = useCallback(() => {
		if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
		reconnectTimerRef.current = null
	}, [])

	const teardown = useCallback(() => {
		relayRef.current?.close()
		relayRef.current = null
		try {
			dataChannelRef.current?.close()
		} catch {
			// Closing an already-closed channel throws in some browsers.
		}
		dataChannelRef.current = null
		try {
			pcRef.current?.close()
		} catch {
			// Same.
		}
		pcRef.current = null
		for (const track of localStreamRef.current?.getTracks() ?? []) {
			track.stop()
		}
		localStreamRef.current = null
		if (remoteAudioRef.current) {
			remoteAudioRef.current.srcObject = null
			remoteAudioRef.current.remove()
			remoteAudioRef.current = null
		}
		mutedRef.current = false
		clearReconnectTimer()
		iceRestartedRef.current = false
	}, [clearReconnectTimer])

	// The one exit from a minted call: tell the server, release everything, then
	// show the post-call toast. Fire-and-forget: a hangup that fails (offline,
	// 5xx) must not trap the user in the dialog, and the server's idle sweeper
	// closes the row regardless.
	const finish = useCallback(
		(reason: 'user_hangup' | 'network_error') => {
			// Taken before the relay closes: it holds what the control channel
			// reported about the transcript, and taking it here is what makes the
			// toast fire once however many exit paths run.
			const call = callRef.current
			callRef.current = null
			const voiceSessionId = voiceSessionIdRef.current
			if (voiceSessionId) {
				voiceSessionIdRef.current = null
				const now = Date.now()
				const inputSeconds = connectedAtRef.current
					? Math.round((now - connectedAtRef.current) / 1000)
					: 0
				const speakingMs = agentSpeakingSinceRef.current ? now - agentSpeakingSinceRef.current : 0
				api.voiceSessions
					.hangup(workspaceId, voiceSessionId, {
						reason,
						input_audio_seconds: inputSeconds,
						output_audio_seconds: Math.round((outputAudioMsRef.current + speakingMs) / 1000),
					})
					.catch(() => {})
			}
			connectedAtRef.current = null
			agentSpeakingSinceRef.current = null
			outputAudioMsRef.current = 0
			teardown()

			// Only when the transcript's fate is known: saved (a conversation
			// exists) or the workspace opted out. If the control channel never
			// connected we know neither, and either message would be a guess. A
			// dropped connection already explains itself in the dialog's notice.
			if (!call || reason !== 'user_hangup') return
			const conversationId = call.conversationId
			if (!conversationId && call.persistTranscripts !== false) return
			const { agentName, navigate } = toastContextRef.current
			showVoiceCallEndedToast({
				durationMs: Date.now() - call.startedAt,
				agentName,
				conversationUrl: conversationId ? `/${workspaceId}/chats/${conversationId}` : null,
				onOpen: () => {
					if (!conversationId) return
					navigate({
						to: '/$workspaceId/chats/$conversationId',
						params: { workspaceId, conversationId },
					})
				},
			})
		},
		[teardown, workspaceId],
	)

	// End the call and let the caller close the dialog.
	const end = useCallback(() => {
		finish('user_hangup')
		setState('permission')
		setNotice(null)
		setTranscriptOpen(false)
		setTranscriptLines([])
	}, [finish])

	// Mount / unmount cleanup — the dialog can be closed at any time (Esc, tap
	// outside, hardware back), and none of those paths currently route through
	// `end()`. This guard makes sure the peer connection never outlives the
	// dialog.
	useEffect(() => {
		if (!open) {
			finish('user_hangup')
			setState('permission')
			setNotice(null)
			setTranscriptOpen(false)
			setTranscriptLines([])
		}
		return () => {
			finish('user_hangup')
		}
	}, [open, finish])

	// Mic-blocked recovers on its own once the user flips the site permission
	// back on, so the dialog does not need a Retry control the SPEC does not
	// list. Browsers without the Permissions API for the microphone just stay
	// on the state until the dialog is reopened.
	useEffect(() => {
		if (state !== 'mic-blocked') return
		let status: PermissionStatus | null = null
		let cancelled = false
		const onChange = () => {
			if (status && status.state !== 'denied') setState('permission')
		}
		navigator.permissions
			?.query({ name: 'microphone' as PermissionName })
			.then((result) => {
				if (cancelled) return
				status = result
				result.addEventListener('change', onChange)
			})
			.catch(() => {})
		return () => {
			cancelled = true
			status?.removeEventListener('change', onChange)
		}
	}, [state])

	const start = useCallback(async () => {
		setNotice(null)

		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		} catch (err) {
			// No session has been minted yet, so there is nothing to hang up.
			if (isMicBlocked(err)) {
				setState('mic-blocked')
			} else if (isMicMissing(err)) {
				setState('no-mic')
			} else {
				setNotice('Could not access a microphone. Check your device settings, then try again.')
				setState('permission')
			}
			return
		}
		localStreamRef.current = stream

		setState('connecting')

		// Session mint. A failure here (route not deployed, agent not
		// voice-enabled, 429) returns the dialog to Permission with a notice.
		let session: Awaited<ReturnType<typeof api.voiceSessions.create>>
		try {
			session = await api.voiceSessions.create(workspaceId, { agent_actor_id: agentActorId })
		} catch (err) {
			teardown()
			if (err instanceof ApiError && err.status === 429) {
				// Vendor rate limit or the workspace's daily minutes: every Call
				// button disables until the server says to retry.
				markVoiceUnavailable(err.retryAfterSeconds ?? 30)
				setNotice(VOICE_UNAVAILABLE_TOOLTIP)
			} else {
				setNotice(err instanceof Error ? err.message : 'Could not start the voice session.')
			}
			setState('permission')
			return
		}
		voiceSessionIdRef.current = session.voice_session_id

		const pc = new RTCPeerConnection()
		pcRef.current = pc

		// Local audio → OpenAI. The mic track is the one thing the mute control
		// flips (track.enabled = false); we hold onto the reference for that.
		for (const track of stream.getTracks()) {
			pc.addTrack(track, stream)
		}

		// Remote audio ← OpenAI. Attach to a floating <audio> element rather than
		// a React-managed one so the audio element outlives any parent re-render
		// during the connect phase.
		const audio = document.createElement('audio')
		audio.autoplay = true
		audio.setAttribute('data-voice-call-audio', 'true')
		document.body.appendChild(audio)
		remoteAudioRef.current = audio
		pc.ontrack = (e) => {
			if (audio && e.streams[0]) audio.srcObject = e.streams[0]
		}

		// Event channel. server_vad emits `input_audio_buffer.speech_started` /
		// `.speech_stopped` for the user side; `response.audio.done` marks the
		// end of an agent utterance. Barge-in is server-side — the UI only
		// mirrors the state, it does not have to cancel anything.
		const dc = pc.createDataChannel('oai-events')
		dataChannelRef.current = dc

		// Tool round-trip and transcript persistence ride the Maskin control
		// channel. The call does not depend on it: if the socket can't be opened,
		// tool calls are answered with an error the agent can voice.
		callRef.current = { startedAt: Date.now(), persistTranscripts: null, conversationId: null }
		setTranscriptLines([])
		const relay = createVoiceRelay({
			url: buildVoiceEventsUrl(session.voice_session_id, API_BASE),
			channel: dc,
			onReady: ({ persistTranscripts, conversationId }) => {
				if (!callRef.current) return
				callRef.current.persistTranscripts = persistTranscripts
				callRef.current.conversationId = conversationId
			},
			onConversation: (conversationId) => {
				if (callRef.current) callRef.current.conversationId = conversationId
			},
			onLine: (line) => setTranscriptLines((prev) => [...prev, line]),
		})
		relayRef.current = relay

		dc.addEventListener('message', (e) => {
			try {
				const evt = JSON.parse(e.data)
				relay.handleRealtimeEvent(evt)
				trackOutputAudio(evt, agentSpeakingSinceRef, outputAudioMsRef)
				handleRealtimeEvent(evt, mutedRef, preMuteStateRef, setState)
				if (evt?.type === 'session.created' && connectedAtRef.current === null) {
					connectedAtRef.current = Date.now()
				}
			} catch {
				// Ignore non-JSON frames (Realtime never sends any).
			}
		})

		pc.addEventListener('iceconnectionstatechange', () => {
			const s = pc.iceConnectionState
			if (s === 'disconnected' || s === 'failed') {
				if (!mutedRef.current) setState('reconnecting')
				// One ICE restart per drop, then the call gets the SPEC's 15s window
				// to recover before it is ended as a network error.
				if (s === 'failed' && !iceRestartedRef.current) {
					iceRestartedRef.current = true
					try {
						pc.restartIce()
					} catch {
						// Closed connection: the timer below ends the call.
					}
				}
				if (!reconnectTimerRef.current) {
					reconnectTimerRef.current = setTimeout(() => {
						reconnectTimerRef.current = null
						finish('network_error')
						setNotice('The connection dropped and could not be restored. Try again.')
						setState('permission')
					}, VOICE_RECONNECT_WINDOW_MS)
				}
			} else if (s === 'connected' || s === 'completed') {
				clearReconnectTimer()
				iceRestartedRef.current = false
				// The initial connect flip to live-agent-speaking is driven by
				// `session.created` in the data channel; this branch handles the
				// recovery flip out of reconnecting.
				setState((prev) => (prev === 'reconnecting' ? 'live-agent-speaking' : prev))
			}
		})

		try {
			const offer = await pc.createOffer()
			await pc.setLocalDescription(offer)

			const sdpResponse = await fetch(
				`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(REALTIME_MODEL)}`,
				{
					method: 'POST',
					body: offer.sdp,
					headers: {
						Authorization: `Bearer ${session.client_secret}`,
						'Content-Type': 'application/sdp',
					},
				},
			)
			if (!sdpResponse.ok) {
				throw new Error(`Realtime handshake returned ${sdpResponse.status}`)
			}
			const answerSdp = await sdpResponse.text()
			await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
		} catch (err) {
			// The row was minted, so release it; otherwise the caller could not
			// start another call until the idle timeout.
			finish('network_error')
			const message = err instanceof Error ? err.message : 'Could not connect to the voice service.'
			setNotice(message)
			setState('permission')
		}
	}, [agentActorId, clearReconnectTimer, finish, teardown, workspaceId])

	const retryMic = useCallback(async () => {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices()
			if (devices.some((d) => d.kind === 'audioinput')) setState('permission')
		} catch {
			// Enumeration unavailable: stay on No-mic; the user can close and reopen.
		}
	}, [])

	const toggleMute = useCallback(() => {
		const stream = localStreamRef.current
		if (!stream) return
		const nextMuted = !mutedRef.current
		mutedRef.current = nextMuted
		for (const track of stream.getAudioTracks()) {
			track.enabled = !nextMuted
		}
		setState((prev) => {
			if (nextMuted) {
				preMuteStateRef.current = prev === 'live-muted' ? preMuteStateRef.current : prev
				return 'live-muted'
			}
			return preMuteStateRef.current
		})
	}, [])

	const toggleTranscript = useCallback(() => setTranscriptOpen((v) => !v), [])

	return {
		state,
		notice,
		transcriptOpen,
		transcriptLines,
		start,
		retryMic,
		toggleMute,
		toggleTranscript,
		end,
	}
}

// Agent audio the call produced, for the cost the server finalises on hangup.
// WebRTC sessions emit output_audio_buffer.started / .stopped (and .cleared on
// barge-in) around every agent utterance.
function trackOutputAudio(
	evt: { type?: string },
	speakingSinceRef: React.RefObject<number | null>,
	outputAudioMsRef: React.RefObject<number>,
) {
	if (evt?.type === 'output_audio_buffer.started') {
		speakingSinceRef.current = Date.now()
	} else if (
		(evt?.type === 'output_audio_buffer.stopped' || evt?.type === 'output_audio_buffer.cleared') &&
		speakingSinceRef.current !== null
	) {
		outputAudioMsRef.current += Date.now() - speakingSinceRef.current
		speakingSinceRef.current = null
	}
}

// Realtime event handler kept outside the component so the closure captured in
// the data-channel listener doesn't retain stale state.
function handleRealtimeEvent(
	evt: { type?: string },
	mutedRef: React.RefObject<boolean>,
	preMuteStateRef: React.RefObject<VoiceCallState>,
	setState: React.Dispatch<React.SetStateAction<VoiceCallState>>,
) {
	if (!evt?.type) return
	if (mutedRef.current) {
		// Muted overrides the visible state, but we still track what the "would
		// be" state is so unmute restores it.
		if (evt.type === 'input_audio_buffer.speech_started')
			preMuteStateRef.current = 'live-user-speaking'
		else if (evt.type === 'input_audio_buffer.speech_stopped')
			preMuteStateRef.current = 'live-agent-speaking'
		else if (evt.type === 'response.audio.done') preMuteStateRef.current = 'live-agent-speaking'
		else if (evt.type === 'response.function_call_arguments.done')
			preMuteStateRef.current = 'live-agent-thinking'
		return
	}
	if (evt.type === 'session.created') setState('live-agent-speaking')
	else if (evt.type === 'input_audio_buffer.speech_started') setState('live-user-speaking')
	else if (evt.type === 'input_audio_buffer.speech_stopped') setState('live-agent-speaking')
	else if (evt.type === 'response.audio.done') setState('live-agent-speaking')
	else if (evt.type === 'response.function_call_arguments.done') setState('live-agent-thinking')
}
