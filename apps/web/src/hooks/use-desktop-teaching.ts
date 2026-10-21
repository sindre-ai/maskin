import type { TeachStartInput } from '@/components/desktop/teach-dialog'
import { useTeachDesktop } from '@/hooks/use-desktop'
import { useSession } from '@/hooks/use-sessions'
import { api } from '@/lib/api'
import { DesktopRecorder, buildTeachRequest } from '@/lib/desktop-recorder'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export type TeachingStatus = 'idle' | 'recording' | 'sending'

type Pending = { recordingId: string; sessionId: string; agentId: string }

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'timeout'])

/**
 * "Teach a task" on the desktop page: records a demonstration while the person
 * drives the desktop, sends it to the chosen agent, and deletes the recording
 * again once that agent's session has ended.
 *
 * `connected` must be false whenever the desktop stream is not live: a recording
 * can't be trusted across a dropped connection, so it is discarded.
 */
export function useDesktopTeaching(opts: {
	workspaceId: string
	/** The element noVNC mounted its canvas into. */
	targetRef: React.RefObject<HTMLElement | null>
	connected: boolean
	/** Teaching needs the person in control; this switches the desktop to/from it. */
	onControl: (controlling: boolean) => void
	onOpenAgent?: (agentId: string) => void
}) {
	const { workspaceId, targetRef, connected, onControl, onOpenAgent } = opts
	const { mutateAsync: sendTeaching } = useTeachDesktop(workspaceId)

	const [dialogOpen, setDialogOpen] = useState(false)
	const [status, setStatus] = useState<TeachingStatus>('idle')
	const [elapsedMs, setElapsedMs] = useState(0)
	const [agentName, setAgentName] = useState<string | null>(null)
	const [pending, setPending] = useState<Pending | null>(null)

	const recorderRef = useRef<DesktopRecorder | null>(null)
	const infoRef = useRef<TeachStartInput | null>(null)
	// Latest `stop`, for the recorder's auto-stop timer (created before `stop` exists).
	const stopRef = useRef<() => Promise<void>>(async () => {})

	const stop = useCallback(async () => {
		const recorder = recorderRef.current
		const info = infoRef.current
		if (!recorder || !info) return
		recorderRef.current = null
		setStatus('sending')
		onControl(false)

		try {
			const demo = await recorder.stop()
			if (demo.events.length === 0) {
				toast.info('Nothing was recorded', {
					description: 'Click, type or scroll on the desktop while recording to show a task.',
				})
				return
			}
			const body = await buildTeachRequest(demo, {
				agentId: info.agentId,
				description: info.description,
			})
			const res = await sendTeaching(body)
			setPending({
				recordingId: res.recording_id,
				sessionId: res.session_id,
				agentId: res.agent_id,
			})
			toast.success(`${info.agentName} is learning this task`, {
				description:
					'It will write a draft skill and attach it to itself. Review it before relying on it.',
				action: onOpenAgent
					? { label: 'View agent', onClick: () => onOpenAgent(info.agentId) }
					: undefined,
			})
		} catch (err) {
			toast.error("Couldn't send the recording", {
				description: err instanceof Error ? err.message : 'Try recording it again.',
			})
		} finally {
			infoRef.current = null
			setAgentName(null)
			setElapsedMs(0)
			setStatus('idle')
		}
	}, [onControl, onOpenAgent, sendTeaching])
	stopRef.current = stop

	const start = useCallback(
		(input: TeachStartInput) => {
			const target = targetRef.current
			if (!target || recorderRef.current) return
			const recorder = new DesktopRecorder({ target, onAutoStop: () => void stopRef.current() })
			recorder.start()
			recorderRef.current = recorder
			infoRef.current = input
			setAgentName(input.agentName)
			setDialogOpen(false)
			setStatus('recording')
			onControl(true)
		},
		[targetRef, onControl],
	)

	// Elapsed time for the header while recording.
	useEffect(() => {
		if (status !== 'recording') return
		const id = setInterval(() => setElapsedMs(recorderRef.current?.elapsedMs ?? 0), 500)
		return () => clearInterval(id)
	}, [status])

	// A dropped stream mid-recording: the steps after the drop would be missing.
	useEffect(() => {
		if (connected || status !== 'recording') return
		const recorder = recorderRef.current
		recorderRef.current = null
		infoRef.current = null
		void recorder?.stop()
		setAgentName(null)
		setElapsedMs(0)
		setStatus('idle')
		toast.warning('The desktop connection dropped', {
			description: 'The recording was discarded. Reconnect and start again.',
		})
	}, [connected, status])

	// Leaving the page mid-recording just discards it (nothing was sent).
	useEffect(
		() => () => {
			void recorderRef.current?.stop()
			recorderRef.current = null
		},
		[],
	)

	// The recording is an input: delete it once the agent's session is over.
	const { data: session } = useSession(pending?.sessionId ?? null, workspaceId)
	useEffect(() => {
		if (!pending || !session || !TERMINAL_SESSION_STATUSES.has(session.status)) return
		const done = pending
		setPending(null)
		void api.desktop.deleteTeaching(workspaceId, done.recordingId, done.agentId).catch(() => {
			// Best effort: the server also sweeps recordings after a few hours.
		})
	}, [pending, session, workspaceId])

	return {
		status,
		elapsedMs,
		agentName,
		dialogOpen,
		openDialog: () => setDialogOpen(true),
		setDialogOpen,
		start,
		stop,
	}
}
