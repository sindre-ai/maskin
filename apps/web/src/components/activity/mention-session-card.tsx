import { SessionDetailPanel } from '@/components/agents/session-detail-panel'
import {
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActor } from '@/hooks/use-actors'
import { useRestartSession, useSessionLogs, useStopSession } from '@/hooks/use-sessions'
import type { SessionLogResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { type SindreEvent, parseSindreLine } from '@/lib/sindre-stream'
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Loader2,
	RotateCcw,
	Square,
	XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

// `superseded` is terminal too (T3/T5) — included here so the status-enum
// expansion doesn't leave it stranded in the active branch.
const TERMINAL_STATUSES = new Set([
	'completed',
	'failed',
	'timeout',
	'paused',
	'stopped',
	'superseded',
])

// 5-second propagation grace from confirm → final `stopped` state. Matches
// the backend's 3s SIGTERM grace + slack for the write-gate to close.
const STOP_GRACE_MS = 5000

interface MentionSessionCardProps {
	session: SessionResponse
	workspaceId: string
}

export function MentionSessionCard({ session, workspaceId }: MentionSessionCardProps) {
	const [panelOpen, setPanelOpen] = useState(false)
	const isTerminal = TERMINAL_STATUSES.has(session.status)

	return (
		<>
			{isTerminal ? (
				<TerminalCard
					session={session}
					workspaceId={workspaceId}
					onOpen={() => setPanelOpen(true)}
				/>
			) : (
				<ActiveCard session={session} workspaceId={workspaceId} onOpen={() => setPanelOpen(true)} />
			)}
			<SessionDetailPanel
				session={session}
				workspaceId={workspaceId}
				open={panelOpen}
				onOpenChange={setPanelOpen}
			/>
		</>
	)
}

function PulsingDots() {
	return (
		<span className="inline-flex items-center gap-0.5">
			<span className="size-1.5 rounded-full bg-current animate-pulse" />
			<span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
			<span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
		</span>
	)
}

function ActiveCard({
	session,
	workspaceId,
	onOpen,
}: {
	session: SessionResponse
	workspaceId: string
	onOpen: () => void
}) {
	const [collapsed, setCollapsed] = useState(true)
	// 'idle' = working, 'confirm' = "Stop?" inside the pill, 'stopping' = 5s grace
	// label after confirm. Server-side `stopping` status also forces this view.
	const [stopUi, setStopUi] = useState<'idle' | 'confirm' | 'stopping'>('idle')
	const confirmBtnRef = useRef<HTMLButtonElement>(null)
	const { data: actor } = useActor(session.actorId)
	const { data: logs } = useSessionLogs(session.id, workspaceId, true, { live: true })
	const stopMutation = useStopSession(workspaceId)

	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const activities = useMemo(() => extractSemanticActivities(logs ?? []), [logs])

	// Sync the local UI with the server-reported `stopping` so a stop initiated
	// elsewhere (a second tab, the SessionDetailPanel) still renders the grace.
	useEffect(() => {
		if (session.status === 'stopping' && stopUi !== 'stopping') setStopUi('stopping')
	}, [session.status, stopUi])

	// Esc cancels the inline confirm — no escape from the in-progress stop.
	useEffect(() => {
		if (stopUi !== 'confirm') return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setStopUi('idle')
		}
		window.addEventListener('keydown', onKey)
		// Move keyboard focus to the confirm button so Enter/Space resolves
		// the decision without round-tripping through the mouse.
		confirmBtnRef.current?.focus()
		return () => window.removeEventListener('keydown', onKey)
	}, [stopUi])

	// Auto-drop the local `Stopping…` after the 5s grace if the server hasn't
	// re-fetched a terminal status yet. The next SSE invalidation will replace
	// this card with TerminalCard; this timer keeps us honest if SSE lags.
	useEffect(() => {
		if (stopUi !== 'stopping') return
		const t = setTimeout(() => setStopUi('idle'), STOP_GRACE_MS)
		return () => clearTimeout(t)
	}, [stopUi])

	const isStopping = stopUi === 'stopping' || session.status === 'stopping'
	const isConfirming = stopUi === 'confirm'

	const workingLabel = idle
		? `${actor?.name ?? 'Agent'} is waiting`
		: `${actor?.name ?? 'Agent'} is working`
	const headerLabel = isStopping ? 'Stopping…' : workingLabel

	const onConfirmStop = () => {
		setStopUi('stopping')
		stopMutation.mutate(session.id)
	}

	return (
		<div className="rounded-md border border-border bg-secondary/30 animate-in fade-in slide-in-from-bottom-1 duration-200">
			{/* Header — pulsing indicator renders from mount without waiting for logs */}
			<div className="flex items-center gap-2 px-3 py-2">
				<span
					className={cn(
						'shrink-0',
						isStopping ? 'text-muted-foreground' : idle ? 'text-muted-foreground' : 'text-primary',
					)}
				>
					{isStopping ? (
						<Loader2 size={14} className="animate-spin" />
					) : idle ? (
						<Clock size={14} />
					) : (
						<PulsingDots />
					)}
				</span>
				{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
				<span className="text-sm font-medium shrink-0">{headerLabel}</span>
				{!isStopping && preview && (
					<span className="text-sm text-muted-foreground truncate min-w-0 flex-1">{preview}</span>
				)}
				<div className="ml-auto shrink-0 flex items-center gap-0.5">
					{isConfirming ? (
						<>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation()
									onConfirmStop()
								}}
								className="rounded px-2 py-0.5 text-xs font-medium text-error hover:bg-secondary transition-colors"
								aria-label="Confirm stop session"
								ref={confirmBtnRef}
							>
								Stop?
							</button>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation()
									setStopUi('idle')
								}}
								className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
								aria-label="Cancel stop"
							>
								Cancel
							</button>
						</>
					) : (
						!isStopping && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation()
									setStopUi('confirm')
								}}
								disabled={stopMutation.isPending}
								className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
								aria-label="Stop session"
								title="Stop session"
							>
								<Square size={12} />
							</button>
						)
					)}
					{activities.length > 0 && !isConfirming && !isStopping && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation()
								setCollapsed((v) => !v)
							}}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							aria-label={collapsed ? 'Show activity' : 'Hide activity'}
							aria-expanded={!collapsed}
						>
							{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
						</button>
					)}
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation()
							onOpen()
						}}
						className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
					>
						logs
					</button>
				</div>
			</div>

			{/* Semantic activity checklist — visible when expanded */}
			{!collapsed && !isConfirming && !isStopping && activities.length > 0 && (
				<div className="border-t border-border px-3 py-2 flex flex-col gap-1">
					{activities.map((activity, idx) => (
						<ActivityRow
							key={activity.id}
							activity={activity}
							isCurrent={idx === activities.length - 1 && !idle}
						/>
					))}
				</div>
			)}
		</div>
	)
}

interface SemanticActivity {
	id: number
	label: string
	kind: 'thinking' | 'tool' | 'text' | 'waiting'
}

function extractSemanticActivities(logs: SessionLogResponse[]): SemanticActivity[] {
	const activities: SemanticActivity[] = []
	let seq = 0

	for (const log of logs) {
		if (log.stream !== 'stdout') continue
		const events = parseSindreLine(log.content, { includeUser: true })
		for (const event of events) {
			const activity = eventToSemanticActivity(event)
			if (!activity) continue
			const last = activities[activities.length - 1]
			if (last && last.label === activity.label) continue
			activities.push({ ...activity, id: seq++ })
		}
	}

	return activities.slice(-8)
}

function eventToSemanticActivity(event: SindreEvent): Omit<SemanticActivity, 'id'> | null {
	switch (event.kind) {
		case 'thinking':
			return { label: 'Thinking', kind: 'thinking' }
		case 'tool_use':
			return { label: friendlyToolName(event.name), kind: 'tool' }
		case 'text':
			return event.text.trim() ? { label: 'Writing response', kind: 'text' } : null
		case 'result':
			return { label: event.isError ? 'Errored' : 'Waiting for input', kind: 'waiting' }
		default:
			return null
	}
}

function friendlyToolName(name: string): string {
	const lower = name.toLowerCase()
	if (lower.includes('read') || lower.includes('glob') || lower.includes('grep'))
		return 'Reading files'
	if (lower.includes('write') || lower.includes('edit') || lower.includes('notebook'))
		return 'Editing files'
	if (lower.includes('bash') || lower.includes('run') || lower.includes('exec'))
		return 'Running commands'
	if (lower.includes('agent') || lower.includes('spawn')) return 'Running agent'
	if (lower.includes('web') || lower.includes('fetch') || lower.includes('search'))
		return 'Searching'
	if (lower.includes('todo')) return 'Updating plan'
	return `Using ${name}`
}

function ActivityRow({
	activity,
	isCurrent,
}: {
	activity: SemanticActivity
	isCurrent: boolean
}) {
	return (
		<div className="flex items-center gap-2 text-xs">
			{isCurrent ? (
				<span className="text-primary shrink-0">
					<PulsingDots />
				</span>
			) : (
				<CheckCircle2 size={10} className="shrink-0 text-muted-foreground/50" />
			)}
			<span className={cn(isCurrent ? 'text-foreground' : 'text-muted-foreground')}>
				{activity.label}
			</span>
		</div>
	)
}

function TerminalCard({
	session,
	workspaceId,
	onOpen,
}: {
	session: SessionResponse
	workspaceId: string
	onOpen: () => void
}) {
	const { data: actor } = useActor(session.actorId)
	const duration = formatDurationBetween(session.startedAt, session.completedAt)
	const status = getTerminalStatus(session.status)
	const canRestart =
		session.status === 'stopped' || session.status === 'failed' || session.status === 'timeout'

	return (
		<div className="flex items-center gap-2 w-full rounded-md border border-border bg-secondary/30 px-3 py-2 hover:bg-secondary/50 transition-colors">
			<button
				type="button"
				onClick={onOpen}
				className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
			>
				<status.Icon size={14} className={cn('shrink-0', status.iconClass)} />
				{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
				<span className="text-sm font-medium shrink-0">{status.label}</span>
				<span className="text-sm text-muted-foreground shrink-0">· view session logs</span>
				{duration && (
					<span className="ml-auto text-xs text-muted-foreground shrink-0">{duration}</span>
				)}
				<ChevronRight size={14} className={cn('shrink-0 text-muted-foreground')} />
			</button>
			{canRestart && <RestartChip sessionId={session.id} workspaceId={workspaceId} />}
		</div>
	)
}

function RestartChip({
	sessionId,
	workspaceId,
}: {
	sessionId: string
	workspaceId: string
}) {
	const restart = useRestartSession(workspaceId)

	return (
		<button
			type="button"
			disabled={restart.isPending}
			onClick={(e) => {
				e.stopPropagation()
				if (restart.isPending) return
				restart.mutate(sessionId)
			}}
			title="Restart session against the latest message state"
			aria-label="Restart session"
			className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
		>
			<RotateCcw size={11} className={cn(restart.isPending && 'animate-spin')} />
			<span>{restart.isPending ? 'Restarting…' : 'Restart'}</span>
		</button>
	)
}

function getTerminalStatus(status: SessionResponse['status']): {
	Icon: typeof CheckCircle2
	label: string
	iconClass: string
} {
	if (status === 'failed') return { Icon: XCircle, label: 'Failed', iconClass: 'text-error' }
	if (status === 'timeout') return { Icon: Clock, label: 'Timed out', iconClass: 'text-error' }
	if (status === 'paused')
		return { Icon: Clock, label: 'Paused', iconClass: 'text-muted-foreground' }
	if (status === 'stopped')
		return { Icon: Square, label: 'Stopped', iconClass: 'text-muted-foreground' }
	if (status === 'superseded')
		return { Icon: CheckCircle2, label: 'Superseded', iconClass: 'text-muted-foreground' }
	return { Icon: CheckCircle2, label: 'Finished', iconClass: 'text-success' }
}
