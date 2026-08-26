import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
	useActorSessions,
	useCreateSession,
	usePauseSession,
	useResumeSession,
} from '@/hooks/use-sessions'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Clock,
	Pause,
	PauseCircle,
	Play,
	RotateCcw,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SessionDetailPanel } from './session-detail-panel'

type SessionState = 'running' | 'waiting' | 'paused' | 'completed' | 'failed'

/** Sessions listed before the section collapses behind "Show all" (mockup 2427). */
const COLLAPSED_SESSIONS = 5

/** Matches `sessionQuerySchema.limit.max(100)` — the hard server cap on one page. */
const MAX_SESSIONS_LOADED = 100

type IconComponent = React.ComponentType<{ className?: string }>

interface StateMeta {
	label: string
	Icon: IconComponent
	iconBg: string
	iconFg: string
	dot: string
}

const STATE_META: Record<SessionState, StateMeta> = {
	running: {
		label: 'Running',
		Icon: Spinner,
		iconBg: 'bg-status-in_progress-bg',
		iconFg: 'text-status-in_progress-text',
		dot: 'bg-status-in_progress-text',
	},
	waiting: {
		label: 'Waiting',
		Icon: Clock,
		iconBg: 'bg-muted',
		iconFg: 'text-muted-foreground',
		dot: 'bg-muted-foreground',
	},
	paused: {
		label: 'Paused',
		Icon: PauseCircle,
		iconBg: 'bg-status-paused-bg',
		iconFg: 'text-status-paused-text',
		dot: 'bg-status-paused-text',
	},
	completed: {
		label: 'Completed',
		Icon: CheckCircle2,
		iconBg: 'bg-status-completed-bg',
		iconFg: 'text-status-completed-text',
		dot: 'bg-status-completed-text',
	},
	failed: {
		label: 'Failed',
		Icon: AlertCircle,
		iconBg: 'bg-status-failed-bg',
		iconFg: 'bg-status-failed-text',
		dot: 'bg-status-failed-text',
	},
}

const RUNNING_STATUSES = new Set(['running', 'starting', 'pending', 'queued', 'snapshotting'])
const WAITING_STATUSES = new Set(['waiting_for_input'])
const PAUSED_STATUSES = new Set(['paused'])
const FAILED_STATUSES = new Set(['failed', 'timeout'])
const COMPLETED_STATUSES = new Set(['completed'])

function deriveState(status: string): SessionState {
	if (RUNNING_STATUSES.has(status)) return 'running'
	if (WAITING_STATUSES.has(status)) return 'waiting'
	if (PAUSED_STATUSES.has(status)) return 'paused'
	if (FAILED_STATUSES.has(status)) return 'failed'
	if (COMPLETED_STATUSES.has(status)) return 'completed'
	return 'waiting'
}

function isActive(state: SessionState): boolean {
	return state === 'running' || state === 'waiting'
}

interface Phase {
	label: string
	text: string
	dot: string
}

function derivePhases(session: SessionResponse, state: SessionState): Phase[] {
	const phases: Phase[] = []
	const meta = STATE_META[state]

	if (session.startedAt) {
		phases.push({
			label: 'START',
			text: session.actionPrompt || 'Session started',
			dot: 'bg-muted-foreground',
		})
	} else if (session.createdAt) {
		phases.push({
			label: 'QUEUED',
			text: session.actionPrompt || 'Waiting to start',
			dot: 'bg-muted-foreground',
		})
	}

	if (isActive(state)) {
		const now = session.currentActivity?.trim() || meta.label
		phases.push({ label: 'NOW', text: now, dot: meta.dot.replace('bg-', 'bg-') })
	}

	if (state === 'completed' || state === 'failed' || state === 'paused') {
		const end =
			state === 'failed'
				? 'Ended with an error'
				: state === 'paused'
					? 'Paused — will resume on the next tick'
					: 'Finished'
		phases.push({ label: 'END', text: end, dot: meta.dot })
	}

	return phases
}

function sortSessions(a: SessionResponse, b: SessionResponse): number {
	const aActive = isActive(deriveState(a.status))
	const bActive = isActive(deriveState(b.status))
	if (aActive !== bActive) return aActive ? -1 : 1
	const aTime = new Date(a.createdAt ?? 0).getTime()
	const bTime = new Date(b.createdAt ?? 0).getTime()
	return bTime - aTime
}

export function AgentSessionsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: sessions, isLoading } = useActorSessions(agent.id, workspaceId)
	const [detailSession, setDetailSession] = useState<SessionResponse | null>(null)
	const [showAll, setShowAll] = useState(false)

	const agentSessions = useMemo(() => {
		return [...(sessions ?? [])].sort(sortSessions)
	}, [sessions])

	// A long-lived agent accumulates hundreds of runs; the newest few answer
	// "what is it doing" without burying every section below them (mockup 2427).
	const isTruncated = agentSessions.length > COLLAPSED_SESSIONS
	const shownSessions =
		showAll || !isTruncated ? agentSessions : agentSessions.slice(0, COLLAPSED_SESSIONS)
	// The API caps a single fetch at 100 rows. When we hit that cap we can't tell
	// exactly how many older sessions exist, so surface an honest hint rather than
	// silently truncating the tail.
	const atFetchCap = agentSessions.length >= MAX_SESSIONS_LOADED
	const showingAllLoaded = showAll || !isTruncated

	// Mockup 2427: the note tells you what you can do here, and turns amber to
	// explain why nothing is moving while the agent itself is paused.
	const isAgentPaused = agent.agentState === 'paused'
	const note = isAgentPaused
		? 'held where they stopped — enable the agent to resume'
		: 'open, pause or restart'

	return (
		<section aria-labelledby="agent-sessions-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-sessions-heading"
				title="Sessions"
				note={note}
				noteClassName={
					isAgentPaused
						? 'min-w-0 truncate text-[11px] text-warning'
						: 'min-w-0 truncate text-[11px] text-muted-foreground'
				}
				action={
					isTruncated ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 shrink-0 px-2 text-xs font-medium"
							aria-expanded={showAll}
							onClick={() => setShowAll((v) => !v)}
						>
							{showAll ? 'Show fewer' : `Show all ${agentSessions.length}`}
						</Button>
					) : undefined
				}
			/>

			{isLoading ? (
				<div className="flex items-center justify-center py-6">
					<Spinner />
				</div>
			) : agentSessions.length === 0 ? (
				<p className="py-4 text-center text-sm text-muted-foreground">
					No sessions yet. Runs will show up here.
				</p>
			) : (
				<>
					<ul className="flex flex-col gap-1.5">
						{shownSessions.map((session) => (
							<li key={session.id}>
								<SessionCard
									session={session}
									agent={agent}
									onOpenLog={() => setDetailSession(session)}
								/>
							</li>
						))}
					</ul>
					{showingAllLoaded && atFetchCap && (
						<p className="pt-1 text-center text-[11px] text-muted-foreground">
							Showing the {MAX_SESSIONS_LOADED} most recent — older sessions aren't listed.
						</p>
					)}
				</>
			)}

			<SessionDetailPanel
				session={detailSession}
				workspaceId={workspaceId}
				open={detailSession !== null}
				onOpenChange={(open) => {
					if (!open) setDetailSession(null)
				}}
			/>
		</section>
	)
}

function SessionCard({
	session,
	agent,
	onOpenLog,
}: {
	session: SessionResponse
	agent: ActorResponse
	onOpenLog: () => void
}) {
	const [open, setOpen] = useState(false)
	const state = deriveState(session.status)
	const meta = STATE_META[state]
	const active = isActive(state)
	const navigate = useNavigate()
	const { workspaceId } = useWorkspace()

	const createSession = useCreateSession(workspaceId)
	const pauseSession = usePauseSession(workspaceId)
	const resumeSession = useResumeSession(workspaceId)

	const name = session.actionPrompt?.trim() || 'Untitled session'
	const duration = formatDurationBetween(session.startedAt, session.completedAt)
	const phases = useMemo(() => derivePhases(session, state), [session, state])
	const StateIcon = meta.Icon

	// Mockup 2444 offers Restart on running / paused / waiting rows. There is no
	// restart endpoint — a restart is a fresh run of the same prompt, which is
	// exactly what `useCreateSession` does.
	const prompt = session.actionPrompt?.trim() ?? ''
	const canRestart =
		prompt.length > 0 && (state === 'running' || state === 'paused' || state === 'waiting')

	const handleRestart = () =>
		createSession.mutate(
			{ actor_id: agent.id, action_prompt: prompt },
			{
				onSuccess: () => toast.success('Session restarted'),
				onError: () => toast.error(`Couldn't restart this session for ${agent.name}`),
			},
		)

	// Mockup 2443's `s.b1`. The backend refuses anything but an exactly-running
	// session for pause, and a paused session needs a snapshot to restore from —
	// so the button only appears where the write path can actually succeed
	// (apps/dev/src/services/session-manager.ts:896 / :1049).
	const canPause = session.status === 'running'
	const canResume = state === 'paused' && !!session.snapshotPath
	const isPauseResumePending = pauseSession.isPending || resumeSession.isPending

	const handlePauseResume = () => {
		if (canPause) {
			pauseSession.mutate(session.id, {
				onSuccess: () => toast.success('Session paused'),
				onError: () => toast.error("Couldn't pause this session"),
			})
			return
		}
		resumeSession.mutate(session.id, {
			onSuccess: () => toast.success('Session resumed'),
			onError: () => toast.error("Couldn't resume this session"),
		})
	}

	const pauseResumeButton = (
		<Button
			size="sm"
			variant="outline"
			className="h-7 rounded-md px-2.5 text-xs"
			onClick={handlePauseResume}
			disabled={isPauseResumePending}
		>
			{canPause ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
			{canPause ? 'Pause' : 'Resume'}
		</Button>
	)

	const restartButton = (
		<Button
			size="sm"
			variant="outline"
			className="h-7 rounded-md px-2.5 text-xs"
			onClick={handleRestart}
			disabled={createSession.isPending}
		>
			<RotateCcw size={12} aria-hidden />
			{createSession.isPending ? 'Restarting…' : 'Restart'}
		</Button>
	)

	return (
		<div
			className={cn(
				'rounded-xl border bg-card transition-colors',
				active ? 'border-border' : 'border-border/70',
			)}
		>
			<div className="flex items-center gap-2.5 px-3 py-2">
				<span
					aria-hidden
					className={cn(
						'grid h-6 w-6 shrink-0 place-items-center rounded-md',
						meta.iconBg,
						meta.iconFg,
					)}
				>
					<StateIcon className="size-3.5" />
				</span>
				<div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
					<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
						{name}
					</span>
					<span className="shrink-0 text-[11px] text-muted-foreground">
						<RelativeTime date={session.startedAt ?? session.createdAt} />
					</span>
				</div>
				<span
					className={cn(
						'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
						meta.iconBg,
						meta.iconFg,
					)}
				>
					{meta.label}
				</span>
				{(canPause || canResume) && (
					<span className="hidden shrink-0 md:inline-flex">{pauseResumeButton}</span>
				)}
				{canRestart && <span className="hidden shrink-0 md:inline-flex">{restartButton}</span>}
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
					aria-expanded={open}
					aria-controls={`session-details-${session.id}`}
					aria-label={open ? `Hide details for ${name}` : `View details for ${name}`}
				>
					{open ? 'Hide' : 'View'}
					{open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
				</button>
			</div>
			{open && (
				<div
					id={`session-details-${session.id}`}
					className="flex flex-col gap-3 border-t border-border bg-muted/30 px-3 py-3"
				>
					<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
						<span className={cn('font-semibold', meta.iconFg)}>{meta.label}</span>
						<span aria-hidden>·</span>
						<span className="min-w-0 truncate">
							{duration ? `${duration} elapsed` : 'not started yet'}
						</span>
					</div>
					<ol className="flex flex-col gap-2">
						{phases.map((phase, idx) => (
							<li key={`${session.id}-${phase.label}-${idx}`} className="flex items-start gap-2.5">
								<span className="eyebrow w-12 shrink-0 pt-[3px]">{phase.label}</span>
								<span
									aria-hidden
									className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', phase.dot)}
								/>
								<span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
									{phase.text}
								</span>
							</li>
						))}
					</ol>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							className="h-7 rounded-md px-3 text-xs"
							onClick={() =>
								navigate({
									to: '/$workspaceId/chats/new',
									params: { workspaceId },
									search: { agentId: agent.id, agentName: agent.name },
								})
							}
						>
							Continue in chat
						</Button>
						<Button
							size="sm"
							variant="outline"
							className="h-7 rounded-md px-3 text-xs"
							onClick={onOpenLog}
						>
							Full log
						</Button>
						{(canPause || canResume) && <span className="md:hidden">{pauseResumeButton}</span>}
						{canRestart && <span className="md:hidden">{restartButton}</span>}
					</div>
				</div>
			)}
		</div>
	)
}

export const __test = {
	deriveState,
	derivePhases,
	sortSessions,
	isActive,
}
