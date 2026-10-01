import { api } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useCallback, useEffect, useRef, useState } from 'react'

// The seven primary states from the Voice v1 design SPEC. Error / empty /
// mic-blocked states land in Task 4. Anything the SPEC calls a "Live (…)" state
// maps here so the dialog can key its render off a single string.
export type VoiceCallState =
	| 'permission'
	| 'connecting'
	| 'live-agent-speaking'
	| 'live-user-speaking'
	| 'live-agent-thinking'
	| 'live-muted'
	| 'reconnecting'

export interface VoiceCall {
	state: VoiceCallState
	/** Non-fatal message surfaced under the primary control (e.g. mic denied
	 *  while still on the Permission screen). Full mic-blocked / no-mic states
	 *  land in Task 4. */
	notice: string | null
	transcriptOpen: boolean
	/** Kick off the WebRTC handshake — call this from the Permission screen's
	 *  Allow button. Requests the mic, mints a Realtime session, and negotiates
	 *  SDP against the OpenAI Realtime edge. */
	start: () => Promise<void>
	toggleMute: () => void
	toggleTranscript: () => void
	end: () => void
}

// The Realtime endpoint. Documented in the tech spec §Auth flow (POST to
// api.openai.com/v1/realtime with the ephemeral client_secret as bearer).
const OPENAI_REALTIME_URL = 'https://api.openai.com/v1/realtime'
const REALTIME_MODEL = 'gpt-realtime'

export function useVoiceCall(agentActorId: string, open: boolean): VoiceCall {
	const { workspaceId } = useWorkspace()
	const [state, setState] = useState<VoiceCallState>('permission')
	const [notice, setNotice] = useState<string | null>(null)
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const mutedRef = useRef(false)
	const preMuteStateRef = useRef<VoiceCallState>('live-agent-speaking')

	// Handles held for tear-down. Everything the call owns must be releasable
	// from one place; a leaked mic track (or a leaked peer connection sitting on
	// the OpenAI edge) is silent and long-lived.
	const pcRef = useRef<RTCPeerConnection | null>(null)
	const localStreamRef = useRef<MediaStream | null>(null)
	const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
	const dataChannelRef = useRef<RTCDataChannel | null>(null)

	const teardown = useCallback(() => {
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
	}, [])

	// End the call and let the caller close the dialog.
	const end = useCallback(() => {
		teardown()
		setState('permission')
		setNotice(null)
		setTranscriptOpen(false)
	}, [teardown])

	// Mount / unmount cleanup — the dialog can be closed at any time (Esc, tap
	// outside, hardware back), and none of those paths currently route through
	// `end()`. This guard makes sure the peer connection never outlives the
	// dialog.
	useEffect(() => {
		if (!open) {
			teardown()
			setState('permission')
			setNotice(null)
			setTranscriptOpen(false)
		}
		return () => {
			teardown()
		}
	}, [open, teardown])

	const start = useCallback(async () => {
		setNotice(null)

		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		} catch (err) {
			// Full mic-blocked / no-mic states are Task 4. For Task 2 we hold the
			// dialog on Permission and surface a one-line notice, so a tester who
			// clicks Deny by accident can retry without reopening the dialog.
			const message =
				err instanceof DOMException && err.name === 'NotAllowedError'
					? 'Microphone permission denied. Enable it in your browser settings, then try again.'
					: 'Could not access a microphone. Check your device settings, then try again.'
			setNotice(message)
			setState('permission')
			return
		}
		localStreamRef.current = stream

		setState('connecting')

		// Session mint. Task 1 owns the route; the client shape is agreed on the
		// task-1 handoff comment. A failure here (route not deployed, agent not
		// voice-enabled, 429) returns the dialog to Permission with a notice —
		// Task 4 owns the dedicated error states.
		let session: Awaited<ReturnType<typeof api.voiceSessions.create>>
		try {
			session = await api.voiceSessions.create(workspaceId, { agent_actor_id: agentActorId })
		} catch (err) {
			teardown()
			const message = err instanceof Error ? err.message : 'Could not start the voice session.'
			setNotice(message)
			setState('permission')
			return
		}

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
		dc.addEventListener('message', (e) => {
			try {
				const evt = JSON.parse(e.data)
				handleRealtimeEvent(evt, mutedRef, preMuteStateRef, setState)
			} catch {
				// Ignore non-JSON frames (Realtime never sends any).
			}
		})

		pc.addEventListener('iceconnectionstatechange', () => {
			if (mutedRef.current) return
			const s = pc.iceConnectionState
			if (s === 'disconnected' || s === 'failed') {
				setState('reconnecting')
			} else if (s === 'connected' || s === 'completed') {
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
			teardown()
			const message = err instanceof Error ? err.message : 'Could not connect to the voice service.'
			setNotice(message)
			setState('permission')
		}
	}, [agentActorId, teardown, workspaceId])

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

	return { state, notice, transcriptOpen, start, toggleMute, toggleTranscript, end }
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
