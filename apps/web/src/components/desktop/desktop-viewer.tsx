import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConnectDesktop } from '@/hooks/use-desktop'
import { cn } from '@/lib/cn'
import type RfbClient from '@novnc/novnc/lib/rfb'
import { Eye, MousePointer2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Phase = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

// Minimal view of the noVNC RFB instance we hold on to.
interface RfbHandle {
	viewOnly: boolean
	disconnect: () => void
	focus: () => void
}

const STATUS_TEXT: Record<Phase, string> = {
	starting: 'Starting your desktop…',
	connecting: 'Connecting…',
	connected: 'Live',
	disconnected: 'Disconnected',
	error: 'Not connected',
}

/**
 * Live view of the workspace desktop. View-only until the user takes over, so
 * watching an agent work can never nudge it by accident. The ticket from
 * connect is single-use, so every (re)connect asks for a fresh one.
 */
export function DesktopViewer({ workspaceId }: { workspaceId: string }) {
	const targetRef = useRef<HTMLDivElement>(null)
	const rfbRef = useRef<RfbHandle | null>(null)
	const [phase, setPhase] = useState<Phase>('starting')
	const [error, setError] = useState<string | null>(null)
	const [controlling, setControlling] = useState(false)
	const [attempt, setAttempt] = useState(0)
	const { mutateAsync: connectDesktop } = useConnectDesktop(workspaceId)

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger, not a value the effect reads.
	useEffect(() => {
		let cancelled = false
		setPhase('starting')
		setError(null)
		setControlling(false)

		void (async () => {
			try {
				const { ticket, path, password } = await connectDesktop()
				if (cancelled) return
				// Loaded on demand: noVNC is only needed on this screen.
				// CommonJS package: depending on interop the class is either the default
				// export or nested one level deeper.
				const mod = (await import('@novnc/novnc/lib/rfb')) as unknown as {
					default: typeof RfbClient | { default: typeof RfbClient }
				}
				const RFB = 'default' in mod.default ? mod.default.default : mod.default
				const target = targetRef.current
				if (cancelled || !target) return

				setPhase('connecting')
				const url = new URL(path, window.location.href)
				url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
				url.searchParams.set('ticket', ticket)

				const rfb = new RFB(target, url.toString(), { credentials: { password } })
				rfb.scaleViewport = true
				rfb.resizeSession = false
				rfb.viewOnly = true
				rfb.addEventListener('connect', () => {
					if (!cancelled) setPhase('connected')
				})
				rfb.addEventListener('disconnect', () => {
					if (cancelled) return
					rfbRef.current = null
					setControlling(false)
					setPhase((prev) => {
						if (prev === 'connected') return 'disconnected'
						setError("Couldn't connect to the desktop.")
						return 'error'
					})
				})
				rfbRef.current = rfb
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : "Couldn't start the desktop.")
				setPhase('error')
			}
		})()

		return () => {
			cancelled = true
			rfbRef.current?.disconnect()
			rfbRef.current = null
		}
	}, [workspaceId, attempt, connectDesktop])

	useEffect(() => {
		const rfb = rfbRef.current
		if (!rfb) return
		rfb.viewOnly = !controlling
		if (controlling) rfb.focus()
	}, [controlling])

	const busy = phase === 'starting' || phase === 'connecting'
	const failed = phase === 'disconnected' || phase === 'error'

	return (
		<div className="flex w-full max-w-5xl flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
					{busy && <Spinner />}
					{STATUS_TEXT[phase]}
				</p>
				{phase === 'connected' && (
					<Button
						variant={controlling ? 'default' : 'outline'}
						size="sm"
						onClick={() => setControlling((v) => !v)}
					>
						{controlling ? <Eye size={15} /> : <MousePointer2 size={15} />}
						{controlling ? 'Stop controlling' : 'Take over'}
					</Button>
				)}
			</div>

			<div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-muted">
				{/* noVNC mounts its canvas into this element and scales it to fit. */}
				<div ref={targetRef} className={cn('size-full', phase !== 'connected' && 'invisible')} />
				{phase === 'starting' && (
					<EmptyState
						className="absolute inset-0 py-0"
						compact
						title="Starting your desktop"
						description="The first start can take up to a minute."
					/>
				)}
				{failed && (
					<EmptyState
						className="absolute inset-0 py-0"
						compact
						title={
							phase === 'disconnected' ? 'The connection was closed' : "Couldn't open the desktop"
						}
						description={error ?? undefined}
						action={
							<Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
								<RefreshCw size={15} />
								Reconnect
							</Button>
						}
					/>
				)}
			</div>
		</div>
	)
}
