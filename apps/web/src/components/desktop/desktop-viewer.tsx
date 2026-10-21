// import { TeachDialog } from '@/components/desktop/teach-dialog'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConnectDesktop } from '@/hooks/use-desktop'
import { type TeachingStatus, useDesktopTeaching } from '@/hooks/use-desktop-teaching'
import { cn } from '@/lib/cn'
import type RfbClient from '@novnc/novnc/lib/rfb'
import { Eye, Maximize2, MousePointer2, RefreshCw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Phase = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

// Minimal view of the noVNC RFB instance we hold on to.
interface RfbHandle {
	viewOnly: boolean
	disconnect: () => void
	focus: () => void
}

const STATUS_TEXT: Record<Phase, string> = {
	starting: 'Starting this computer…',
	connecting: 'Connecting…',
	connected: 'Live',
	disconnected: 'Disconnected',
	error: 'Not connected',
}

function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000)
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function DesktopStatus({
	phase,
	teaching,
	elapsedMs,
	agentName,
}: {
	phase: Phase
	teaching: TeachingStatus
	elapsedMs: number
	agentName: string | null
}) {
	if (teaching !== 'idle') {
		return (
			<p
				className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground"
				aria-live="polite"
			>
				{teaching === 'recording' ? (
					<span
						aria-hidden="true"
						className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive"
					/>
				) : (
					<Spinner className="shrink-0" />
				)}
				<span className="truncate">
					{teaching === 'recording'
						? `Recording · ${formatElapsed(elapsedMs)}${agentName ? ` · teaching ${agentName}` : ''}`
						: `Sending to ${agentName ?? 'the agent'}…`}
				</span>
			</p>
		)
	}
	const busy = phase === 'starting' || phase === 'connecting'
	return (
		<p
			className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground"
			aria-live="polite"
		>
			{busy && <Spinner className="shrink-0" />}
			{phase === 'connected' && (
				<span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
			)}
			<span className="truncate">{STATUS_TEXT[phase]}</span>
		</p>
	)
}

/**
 * Live view of ONE agent's computer, with its own toolbar (status, Teach a task,
 * Take over). View-only until the user takes over, so watching an agent work can
 * never nudge it by accident. The ticket from connect is single-use, so every
 * (re)connect asks for a fresh one. Used inline on the agent page and again,
 * larger, in the expanded popup: pass the Expand / Close button as `toolbarEnd`.
 */
export function DesktopViewer({
	workspaceId,
	agentId,
	toolbarEnd,
	variant = 'inline',
	onOpen,
	onOpenAgent,
}: {
	workspaceId: string
	/** Whose computer this is: every agent has its own. */
	agentId: string
	/** Rendered at the far end of the toolbar (the Expand / Close button). */
	toolbarEnd?: React.ReactNode
	/**
	 * `inline`: toolbar above the picture. `preview`: just the picture, for a card that opens
	 * the popup. `immersive`: the popup, controls float under the picture.
	 */
	variant?: 'inline' | 'preview' | 'immersive'
	/** `preview` only: what clicking the live picture does (open the popup). */
	onOpen?: () => void
	/** Where "View agent" goes after a recording is sent. Optional: needs the router. */
	onOpenAgent?: (agentId: string) => void
}) {
	const targetRef = useRef<HTMLDivElement>(null)
	const rfbRef = useRef<RfbHandle | null>(null)
	const [phase, setPhase] = useState<Phase>('starting')
	const [error, setError] = useState<string | null>(null)
	const [controlling, setControlling] = useState(false)
	const [attempt, setAttempt] = useState(0)
	const { mutateAsync: connectDesktop } = useConnectDesktop(workspaceId, agentId)

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
	}, [workspaceId, agentId, attempt, connectDesktop])

	useEffect(() => {
		const rfb = rfbRef.current
		if (!rfb) return
		rfb.viewOnly = !controlling
		if (controlling) rfb.focus()
	}, [controlling])

	const busy = phase === 'starting' || phase === 'connecting'
	const failed = phase === 'disconnected' || phase === 'error'
	const teaching = useDesktopTeaching({
		workspaceId,
		targetRef,
		connected: phase === 'connected',
		onControl: setControlling,
		onOpenAgent,
	})
	const recording = teaching.status === 'recording'
	const sending = teaching.status === 'sending'

	const controls =
		phase === 'connected' ? (
			recording ? (
				<Button
					variant="destructive"
					size="sm"
					aria-label="Stop recording"
					onClick={() => void teaching.stop()}
				>
					<Square size={14} />
					<span className="hidden sm:inline">Stop</span>
				</Button>
			) : (
				<>
					{/* "Teach a task" is switched off until the feature is further developed.
					<Button
						variant="outline"
						size="sm"
						aria-label="Teach a task"
						disabled={sending}
						onClick={teaching.openDialog}
					>
						<GraduationCap size={15} />
						<span className="hidden sm:inline">Teach a task</span>
					</Button>
					*/}
					<Button
						variant={controlling ? 'default' : 'outline'}
						size="sm"
						aria-label={controlling ? 'Stop controlling' : 'Take over'}
						disabled={sending}
						onClick={() => setControlling((v) => !v)}
					>
						{controlling ? <Eye size={15} /> : <MousePointer2 size={15} />}
						<span className="hidden sm:inline">
							{controlling ? 'Stop controlling' : 'Take over'}
						</span>
					</Button>
				</>
			)
		) : null

	// The popup's floating pill: what you are doing on the left, the one switch on the right.
	const pill = (
		<div
			role="toolbar"
			aria-label="Computer controls"
			className="flex items-center gap-1 self-center rounded-full border bg-card p-1 shadow-md"
		>
			<span className="flex items-center gap-1.5 px-3 text-sm text-muted-foreground">
				{controlling ? <MousePointer2 size={15} /> : <Eye size={15} />}
				{controlling ? "You're in control" : 'Watching'}
			</span>
			<Button
				variant={controlling ? 'secondary' : 'default'}
				size="sm"
				className="rounded-full"
				aria-label={controlling ? 'Stop controlling' : 'Take over'}
				disabled={sending}
				onClick={() => setControlling((v) => !v)}
			>
				{controlling ? 'Stop' : 'Take control'}
			</Button>
		</div>
	)

	return (
		<div className="flex min-w-0 flex-col gap-2">
			{variant === 'inline' && (
				<div
					role="toolbar"
					aria-label="Computer controls"
					className="flex min-w-0 items-center justify-between gap-2"
				>
					<div className="min-w-0">
						<DesktopStatus
							phase={phase}
							teaching={teaching.status}
							elapsedMs={teaching.elapsedMs}
							agentName={teaching.agentName}
						/>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{controls}
						{toolbarEnd}
					</div>
				</div>
			)}

			<div
				className={cn(
					'group relative aspect-video w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted',
					recording && 'ring-2 ring-destructive',
				)}
			>
				{/* noVNC mounts its canvas into this element and scales it to fit. */}
				<div
					ref={targetRef}
					className={cn(
						// noVNC's own wrapper scrolls when the picture overflows it, and its
						// scrollbars then change the room it fits into: never let it scroll.
						'size-full [&>div]:overflow-hidden!',
						phase !== 'connected' && 'invisible',
					)}
				/>
				{/* Not on the error state: that card holds a Reconnect button this must not cover. */}
				{variant === 'preview' && onOpen && !failed && (
					<button
						type="button"
						aria-label="Open computer in a popup"
						onClick={onOpen}
						className="absolute inset-0 z-10 flex items-center justify-center focus-visible:outline-none"
					>
						<span className="flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
							<Maximize2 size={15} />
							Open
						</span>
					</button>
				)}
				{busy && (
					<EmptyState
						className="absolute inset-0 py-0"
						compact
						title={phase === 'starting' ? 'This can take a moment' : 'Almost there'}
						description={
							phase === 'starting' ? 'The first start can take up to a minute.' : undefined
						}
					/>
				)}
				{failed && (
					<EmptyState
						className="absolute inset-0 py-0"
						compact
						// A closed stream is an idle computer going to sleep, not a fault.
						title={phase === 'disconnected' ? 'The computer is idle' : "Couldn't open the desktop"}
						description={error ?? undefined}
						action={
							<Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
								<RefreshCw size={15} />
								{phase === 'disconnected' ? 'Wake up' : 'Reconnect'}
							</Button>
						}
					/>
				)}
			</div>
			{variant === 'immersive' && phase === 'connected' && (recording ? controls : pill)}
			{/* <TeachDialog
				open={teaching.dialogOpen}
				onOpenChange={teaching.setDialogOpen}
				workspaceId={workspaceId}
				onStart={teaching.start}
			/> */}
		</div>
	)
}
