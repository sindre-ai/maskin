import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { RelativeTime } from '@/components/shared/relative-time'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCanWrite } from '@/hooks/use-can-write'
import type { ConversationThread } from '@/hooks/use-conversation-threads'
import { useDuration } from '@/hooks/use-duration'
import {
	useActorSessions,
	useCreateSession,
	usePauseSession,
	useResumeSession,
	useStopSession,
} from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import { type ActorResponse, ApiError, type SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationCoarse } from '@/lib/format-duration'
import { backgroundTitle, buildBackgroundThreads } from '@/lib/session-thread'
import { useWorkspace } from '@/lib/workspace-context'
import { isViewerRefusal } from '@/lib/workspace-role'
import {
	AlertCircle,
	CheckCircle2,
	ChevronRight,
	Clock,
	Pause,
	PauseCircle,
	Play,
	RotateCcw,
	XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SessionPanel } from './session-panel'

type SessionState = 'running' | 'waiting' | 'paused' | 'completed' | 'stopped' | 'failed'

/** Sessions listed before the section collapses behind "Show all" (mockup 2427). */
const COLLAPSED_SESSIONS = 5

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
	stopped: {
		label: 'Stopped',
		Icon: XCircle,
		iconBg: 'bg-muted',
		iconFg: 'text-muted-foreground',
		dot: 'bg-muted-foreground',
	},
	failed: {
		label: 'Failed',
		Icon: AlertCircle,
		iconBg: 'bg-status-failed-bg',
		iconFg: 'text-status-failed-text',
		dot: 'bg-status-failed-text',
	},
}

// The compact (Overview) rows draw a finished run grey and a failed one with a red word on
// grey; only a live run is coloured as a plate (v11).
const COMPACT_STYLE: Partial<Record<SessionState, { dot: string; pill: string }>> = {
	running: { dot: 'bg-success', pill: 'bg-status-in_progress-bg text-success' },
	completed: { dot: 'bg-muted-foreground', pill: 'bg-muted text-muted-foreground' },
	failed: { dot: 'bg-status-failed-text', pill: 'bg-muted text-status-failed-text' },
}

const RUNNING_STATUSES = new Set(['running', 'starting', 'pending', 'queued', 'snapshotting'])
const WAITING_STATUSES = new Set(['waiting_for_input'])
const PAUSED_STATUSES = new Set(['paused'])
const FAILED_STATUSES = new Set(['failed', 'timeout'])
const STOPPED_STATUSES = new Set(['user_stopped'])
const COMPLETED_STATUSES = new Set(['completed'])

function deriveState(status: string): SessionState {
	if (RUNNING_STATUSES.has(status)) return 'running'
	if (WAITING_STATUSES.has(status)) return 'waiting'
	if (PAUSED_STATUSES.has(status)) return 'paused'
	if (FAILED_STATUSES.has(status)) return 'failed'
	if (STOPPED_STATUSES.has(status)) return 'stopped'
	if (COMPLETED_STATUSES.has(status)) return 'completed'
	return 'waiting'
}

function isActive(state: SessionState): boolean {
	return state === 'running' || state === 'waiting'
}

/** The Sessions tab's chips: everything, still going (or held), finished, failed. */
type SessionFilter = 'running' | 'done' | 'failed' | undefined

const SESSION_FILTERS: Array<{ label: string; value: SessionFilter }> = [
	{ label: 'All', value: undefined },
	{ label: 'Running', value: 'running' },
	{ label: 'Done', value: 'done' },
	{ label: 'Failed', value: 'failed' },
]

function matchesFilter(state: SessionState, filter: SessionFilter): boolean {
	if (!filter) return true
	if (filter === 'running') return state === 'running' || state === 'waiting' || state === 'paused'
	if (filter === 'done') return state === 'completed' || state === 'stopped'
	return state === 'failed'
}

function sortSessions(
	a: Pick<SessionResponse, 'status' | 'createdAt'>,
	b: Pick<SessionResponse, 'status' | 'createdAt'>,
): number {
	const aActive = isActive(deriveState(a.status))
	const bActive = isActive(deriveState(b.status))
	if (aActive !== bActive) return aActive ? -1 : 1
	const aTime = new Date(a.createdAt ?? 0).getTime()
	const bTime = new Date(b.createdAt ?? 0).getTime()
	return bTime - aTime
}

export function AgentSessionsSection({
	agent,
	compact = false,
	limit,
	onSeeAll,
	openId: controlledOpenId,
	onOpenIdChange,
}: {
	agent: ActorResponse
	/** The Overview's "Recent sessions": calm rows (state dot, title, how long and when, a
	 *  status word, a chevron) with no per-row buttons. The row opens the run. */
	compact?: boolean
	/** Show only the newest N rows and no "Show all" toggle. */
	limit?: number
	/** "See all" in the heading, for a compact list that is a taste of the Sessions tab. */
	onSeeAll?: () => void
	/** The run open in the side panel, when the page owns that state (its banner opens runs
	 *  too). Without it the section keeps its own. */
	openId?: string | null
	onOpenIdChange?: (id: string | null) => void
}) {
	const { workspaceId } = useWorkspace()
	const { data: sessions, isLoading } = useActorSessions(agent.id, workspaceId)
	const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
	const openId = controlledOpenId !== undefined ? controlledOpenId : ownOpenId
	const setOpenId = onOpenIdChange ?? setOwnOpenId
	const [showAll, setShowAll] = useState(false)
	const [filter, setFilter] = useState<SessionFilter>(undefined)

	const { data: triggers } = useTriggers(workspaceId)
	const triggerNames = useMemo(
		() => new Map((triggers ?? []).map((t) => [t.id, t.name])),
		[triggers],
	)

	// A follow-up the person wrote after a run ended carries on in that run's thread, so
	// the list has one row per thread, showing the newest session's state.
	const agentSessions = useMemo(() => {
		const rows = buildBackgroundThreads(sessions ?? [], agent.name).map((thread) => ({
			thread,
			root: (sessions ?? []).find((s) => s.id === thread.id) as SessionResponse,
			latest: (sessions ?? []).find((s) => s.id === thread.latestId),
		}))
		return rows.sort((a, b) =>
			sortSessions(
				{ status: a.thread.status, createdAt: a.thread.createdAt },
				{ status: b.thread.status, createdAt: b.thread.createdAt },
			),
		)
	}, [sessions, agent.name])

	const openThread = useMemo(() => {
		const row = agentSessions.find((r) => r.thread.id === openId)
		if (!row) return null
		const triggerName = row.root.triggerId ? triggerNames.get(row.root.triggerId) : undefined
		return { thread: row.thread, title: backgroundTitle(triggerName, row.root.actionPrompt) }
	}, [agentSessions, openId, triggerNames])

	// A long-lived agent accumulates hundreds of runs; the newest few answer
	// "what is it doing" without burying every section below them (mockup 2427).
	const filteredSessions = useMemo(
		() => agentSessions.filter((r) => matchesFilter(deriveState(r.thread.status), filter)),
		[agentSessions, filter],
	)
	const isTruncated = limit === undefined && filteredSessions.length > COLLAPSED_SESSIONS
	const shownSessions =
		limit !== undefined
			? filteredSessions.slice(0, limit)
			: showAll || !isTruncated
				? filteredSessions
				: filteredSessions.slice(0, COLLAPSED_SESSIONS)

	// Mockup 2427: the note tells you what you can do here, and turns amber to
	// explain why nothing is moving while the agent itself is paused.
	const isAgentPaused = agent.agentState === 'paused'
	const note = isAgentPaused
		? 'held where they stopped — enable the agent to resume'
		: 'open, pause or restart'

	return (
		<section aria-labelledby="agent-sessions-heading" className="flex flex-col gap-2.5">
			{/* The Sessions tab opens on the chips, as v16 draws it; its heading stays for screen
			    readers and the Overview's "Recent sessions" keeps the visible one. */}
			<AgentSectionHeading
				id="agent-sessions-heading"
				title={compact ? 'Recent sessions' : 'Sessions'}
				note={compact ? undefined : note}
				noteClassName={
					isAgentPaused
						? 'min-w-0 truncate text-[11px] text-warning'
						: 'min-w-0 truncate text-[11px] text-muted-foreground'
				}
				srOnly={!compact}
				action={
					onSeeAll && agentSessions.length > 0 ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 shrink-0 px-2 text-[13px] font-semibold text-brand"
							onClick={onSeeAll}
						>
							See all
						</Button>
					) : undefined
				}
			/>

			{!compact && agentSessions.length > 0 && (
				<FilterTabs
					variant="chip"
					aria-label="Filter sessions by state"
					className="mb-1.5 flex-wrap overflow-visible"
					tabs={SESSION_FILTERS}
					value={filter}
					onChange={(next) => {
						setFilter(next)
						setShowAll(false)
					}}
				/>
			)}

			{isLoading ? (
				<div className="flex items-center justify-center py-6">
					<Spinner />
				</div>
			) : agentSessions.length === 0 ? (
				<p className="py-4 text-center text-sm text-muted-foreground">
					No sessions yet. Runs will show up here.
				</p>
			) : filteredSessions.length === 0 ? (
				<p className="py-4 text-center text-sm text-muted-foreground">No sessions in that state.</p>
			) : (
				<ul className="flex flex-col border-t border-border">
					{shownSessions.map(({ thread, root, latest }) => (
						<li key={thread.id}>
							<SessionCard
								session={root}
								latest={latest ?? root}
								thread={thread}
								title={backgroundTitle(
									root.triggerId ? triggerNames.get(root.triggerId) : undefined,
									root.actionPrompt,
								)}
								agent={agent}
								compact={compact}
								selected={thread.id === openId}
								onOpen={() => setOpenId(thread.id)}
							/>
						</li>
					))}
				</ul>
			)}

			{isTruncated && (
				<Button
					variant="ghost"
					size="sm"
					className="h-7 self-start px-2 text-[13px] font-semibold text-muted-foreground"
					aria-expanded={showAll}
					onClick={() => setShowAll((v) => !v)}
				>
					{showAll ? 'Show fewer' : `Show all ${filteredSessions.length}`}
				</Button>
			)}

			{openThread ? (
				<SessionPanel
					workspaceId={workspaceId}
					thread={openThread.thread}
					title={openThread.title}
					onClose={() => setOpenId(null)}
				/>
			) : null}
		</section>
	)
}

function RunningFor({ startedAt }: { startedAt: string | null }) {
	const duration = useDuration(startedAt, formatDurationCoarse)
	return <>{duration ? `Running for ${duration}` : 'Running'}</>
}

const COMPACT_LABEL: Record<SessionState, string> = {
	running: 'Working',
	waiting: 'Waiting',
	paused: 'Paused',
	completed: 'Done',
	stopped: 'Stopped',
	failed: 'Failed',
}

function SessionCard({
	session,
	latest,
	thread,
	title,
	agent,
	compact,
	selected,
	onOpen,
}: {
	/** The run the thread started with: its trigger, prompt and snapshot. */
	session: SessionResponse
	/** The thread's newest run: the one Pause and Resume act on. */
	latest: SessionResponse
	/** The run and every follow-up after it; its status is the newest session's. */
	thread: ConversationThread
	/** What the row is called: the trigger's name. */
	title: string
	agent: ActorResponse
	compact: boolean
	/** The run is open in the side panel. */
	selected: boolean
	onOpen: () => void
}) {
	const state = deriveState(thread.status)
	const meta = STATE_META[state]
	const active = isActive(state)
	const { workspaceId } = useWorkspace()

	const createSession = useCreateSession(workspaceId)
	const pauseSession = usePauseSession(workspaceId)
	const resumeSession = useResumeSession(workspaceId)
	const stopSession = useStopSession(workspaceId)
	// Pause, resume and restart all act on the session, which a viewer cannot do.
	const canWrite = useCanWrite()

	const name = title

	// A running row offers Stop (v3 screenshot 21), not Restart. Restart is on paused / waiting rows; a failed or stopped run can be run again too. There is no
	// restart endpoint — a restart is a fresh run of the same prompt, which is
	// exactly what `useCreateSession` does. It carries the trigger too, so the new
	// run keeps the trigger's name as its title.
	const prompt = session.actionPrompt?.trim() ?? ''
	// A run on an agent server cannot be paused (snapshots are local-only), so a live one offers
	// Restart beside Stop: the only way to start it over.
	const runsOnAgentServer = thread.status === 'running' && !!latest.agentServerId
	const canRestart =
		prompt.length > 0 &&
		(runsOnAgentServer ||
			state === 'paused' ||
			state === 'waiting' ||
			state === 'failed' ||
			state === 'stopped')

	const handleRestart = () =>
		createSession.mutate(
			{
				actor_id: agent.id,
				action_prompt: prompt,
				...(session.triggerId ? { trigger_id: session.triggerId } : {}),
			},
			{
				onSuccess: () => toast.success('Session restarted'),
				onError: (err) => {
					if (!isViewerRefusal(err)) toast.error(`Couldn't restart this session for ${agent.name}`)
				},
			},
		)

	// Mockup 2443's `s.b1`. The backend refuses anything but an exactly-running
	// session for pause, and a paused session needs a snapshot to restore from —
	// so the button only appears where the write path can actually succeed
	// (apps/dev/src/services/session-manager.ts, pauseSession / resumeSession).
	// Sessions on an agent server pause and resume too.
	const canPause = thread.status === 'running'
	const canResume = state === 'paused' && thread.latestId === session.id && !!session.snapshotPath
	const isPauseResumePending = pauseSession.isPending || resumeSession.isPending

	const handlePauseResume = () => {
		if (canPause) {
			pauseSession.mutate(thread.latestId, {
				onSuccess: () => toast.success('Session paused'),
				onError: (err) => {
					if (!isViewerRefusal(err))
						toast.error(err instanceof ApiError ? err.message : "Couldn't pause this session")
				},
			})
			return
		}
		resumeSession.mutate(thread.latestId, {
			onSuccess: () => toast.success('Session resumed'),
			onError: (err) => {
				if (!isViewerRefusal(err)) toast.error("Couldn't resume this session")
			},
		})
	}

	const pauseResumeButton = (
		<ViewerTooltip>
			<Button
				size="sm"
				variant="outline"
				className="h-7 rounded-full px-3 text-xs font-semibold"
				onClick={handlePauseResume}
				disabled={isPauseResumePending || !canWrite}
			>
				{canPause ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
				<span className="sr-only md:not-sr-only">{canPause ? 'Pause' : 'Resume'}</span>
			</Button>
		</ViewerTooltip>
	)

	const stopButton = (
		<ViewerTooltip>
			<Button
				size="sm"
				variant="outline"
				className="h-7 rounded-full px-3 text-xs font-semibold"
				onClick={() => stopSession.mutate(thread.latestId)}
				disabled={stopSession.isPending || !canWrite}
			>
				{stopSession.isPending ? 'Stopping…' : 'Stop'}
			</Button>
		</ViewerTooltip>
	)

	const restartButton = (
		<ViewerTooltip>
			<Button
				size="sm"
				variant="outline"
				className="h-7 rounded-full px-3 text-xs font-semibold"
				onClick={handleRestart}
				disabled={createSession.isPending || !canWrite}
			>
				<RotateCcw size={12} aria-hidden />
				<span className="sr-only md:not-sr-only">
					{runsOnAgentServer
						? createSession.isPending
							? 'Restarting…'
							: 'Restart'
						: createSession.isPending
							? 'Retrying…'
							: 'Retry'}
				</span>
			</Button>
		</ViewerTooltip>
	)

	const duration = session.startedAt
		? formatDurationCoarse(
				(session.completedAt ? new Date(session.completedAt).getTime() : Date.now()) -
					new Date(session.startedAt).getTime(),
			)
		: null
	const rowStyle = COMPACT_STYLE[state] ?? {
		dot: meta.dot,
		pill: cn(meta.iconBg, meta.iconFg),
	}
	const statusPill = (
		<span
			className={cn(
				'shrink-0 rounded-full px-2.5 py-[3px] text-xs font-semibold leading-snug',
				rowStyle.pill,
			)}
		>
			{COMPACT_LABEL[state]}
		</span>
	)
	const label = (
		<>
			<span aria-hidden className={cn('size-2 shrink-0 rounded-full', rowStyle.dot)} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-[15px] font-semibold text-foreground">{name}</span>
				<span className="truncate text-[13px] text-muted-foreground">
					{state === 'running' ? (
						<RunningFor startedAt={session.startedAt} />
					) : (
						<>
							{duration}
							{duration && ' · '}
							<RelativeTime date={session.startedAt ?? session.createdAt} />
						</>
					)}
				</span>
			</span>
		</>
	)
	const rowClass =
		'flex items-center gap-3.5 px-1 py-2.5 text-left leading-snug transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

	// The Overview's rows open the run and carry no buttons of their own.
	if (compact) {
		return (
			<button
				type="button"
				onClick={onOpen}
				aria-pressed={selected}
				aria-label={`Open ${name}`}
				className={cn(rowClass, 'w-full border-b border-border')}
			>
				{label}
				{statusPill}
				<ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
			</button>
		)
	}

	// The Sessions tab draws the same calm row with Pause / Resume / Restart as outlined pills
	// before the status word. The buttons sit beside the row button, never inside it.
	return (
		<div className="flex items-center gap-2 border-b border-border">
			<button
				type="button"
				onClick={onOpen}
				aria-pressed={selected}
				aria-label={`Open ${name}`}
				className={cn(rowClass, 'min-w-0 flex-1')}
			>
				{label}
			</button>
			{(canPause || canResume) && <span className="shrink-0">{pauseResumeButton}</span>}
			{thread.status === 'running' && <span className="shrink-0">{stopButton}</span>}
			{canRestart && <span className="shrink-0">{restartButton}</span>}
			<button
				type="button"
				onClick={onOpen}
				aria-hidden
				tabIndex={-1}
				className="flex shrink-0 items-center gap-3.5 py-2.5 pl-1 pr-1"
			>
				{statusPill}
				<ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
			</button>
		</div>
	)
}

export const __test = {
	deriveState,
	sortSessions,
	isActive,
}
