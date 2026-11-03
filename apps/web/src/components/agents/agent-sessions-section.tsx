import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { RelativeTime } from '@/components/shared/relative-time'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCanWrite } from '@/hooks/use-can-write'
import type { ConversationThread } from '@/hooks/use-conversation-threads'
import {
	useActorSessions,
	useCreateSession,
	usePauseSession,
	useResumeSession,
} from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { backgroundTitle, buildBackgroundThreads } from '@/lib/session-thread'
import { useWorkspace } from '@/lib/workspace-context'
import { isViewerRefusal } from '@/lib/workspace-role'
import {
	AlertCircle,
	CheckCircle2,
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

export function AgentSessionsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: sessions, isLoading } = useActorSessions(agent.id, workspaceId)
	const [openId, setOpenId] = useState<string | null>(null)
	const [showAll, setShowAll] = useState(false)

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
	const isTruncated = agentSessions.length > COLLAPSED_SESSIONS
	const shownSessions =
		showAll || !isTruncated ? agentSessions : agentSessions.slice(0, COLLAPSED_SESSIONS)

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
				<ul className="flex flex-col gap-1.5">
					{shownSessions.map(({ thread, root }) => (
						<li key={thread.id}>
							<SessionCard
								session={root}
								thread={thread}
								title={backgroundTitle(
									root.triggerId ? triggerNames.get(root.triggerId) : undefined,
									root.actionPrompt,
								)}
								agent={agent}
								selected={thread.id === openId}
								onOpen={() => setOpenId(thread.id)}
							/>
						</li>
					))}
				</ul>
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

function SessionCard({
	session,
	thread,
	title,
	agent,
	selected,
	onOpen,
}: {
	/** The run the thread started with: its trigger, prompt and snapshot. */
	session: SessionResponse
	/** The run and every follow-up after it; its status is the newest session's. */
	thread: ConversationThread
	/** What the row is called: the trigger's name. */
	title: string
	agent: ActorResponse
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
	// Pause, resume and restart all act on the session, which a viewer cannot do.
	const canWrite = useCanWrite()

	const name = title
	const StateIcon = meta.Icon

	// Mockup 2444 offers Restart on running / paused / waiting rows; a failed or stopped run can be run again too. There is no
	// restart endpoint — a restart is a fresh run of the same prompt, which is
	// exactly what `useCreateSession` does. It carries the trigger too, so the new
	// run keeps the trigger's name as its title.
	const prompt = session.actionPrompt?.trim() ?? ''
	const canRestart =
		prompt.length > 0 &&
		(state === 'running' ||
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
	// (apps/dev/src/services/session-manager.ts:896 / :1049).
	const canPause = thread.status === 'running'
	const canResume = state === 'paused' && thread.latestId === session.id && !!session.snapshotPath
	const isPauseResumePending = pauseSession.isPending || resumeSession.isPending

	const handlePauseResume = () => {
		if (canPause) {
			pauseSession.mutate(thread.latestId, {
				onSuccess: () => toast.success('Session paused'),
				onError: (err) => {
					if (!isViewerRefusal(err)) toast.error("Couldn't pause this session")
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
				className="h-7 rounded-md px-2.5 text-xs"
				onClick={handlePauseResume}
				disabled={isPauseResumePending || !canWrite}
			>
				{canPause ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
				<span className="sr-only md:not-sr-only">{canPause ? 'Pause' : 'Resume'}</span>
			</Button>
		</ViewerTooltip>
	)

	const restartButton = (
		<ViewerTooltip>
			<Button
				size="sm"
				variant="outline"
				className="h-7 rounded-md px-2.5 text-xs"
				onClick={handleRestart}
				disabled={createSession.isPending || !canWrite}
			>
				<RotateCcw size={12} aria-hidden />
				<span className="sr-only md:not-sr-only">
					{createSession.isPending ? 'Restarting…' : 'Restart'}
				</span>
			</Button>
		</ViewerTooltip>
	)

	return (
		<div
			className={cn(
				'rounded-xl border bg-card transition-colors',
				selected ? 'border-brand' : active ? 'border-border' : 'border-border/70',
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
				{(canPause || canResume) && <span className="shrink-0">{pauseResumeButton}</span>}
				{canRestart && <span className="shrink-0">{restartButton}</span>}
				<Button
					size="sm"
					variant="outline"
					className="h-7 shrink-0 rounded-md px-2.5 text-xs"
					onClick={onOpen}
					aria-pressed={selected}
					aria-label={`Open ${name}`}
				>
					Open
				</Button>
			</div>
		</div>
	)
}

export const __test = {
	deriveState,
	sortSessions,
	isActive,
}
