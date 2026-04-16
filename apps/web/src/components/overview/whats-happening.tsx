import { AgentCard } from '@/components/agents/agent-card'
import { BetCard } from '@/components/bets/bet-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { useActors } from '@/hooks/use-actors'
import { useBets } from '@/hooks/use-bets'
import { useObjects } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import type {
	ActorListItem,
	ActorResponse,
	ObjectResponse,
	RelationshipResponse,
	SessionResponse,
} from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'

const ACTIVE_BET_STATUSES = new Set(['active'])
const PROPOSED_BET_STATUSES = new Set(['proposed'])
const COMPLETED_BET_STATUSES = new Set(['completed', 'archived'])
const ACTIVE_SESSION_STATUSES = new Set(['running', 'starting', 'pending'])

export function WhatsHappening() {
	const { workspaceId } = useWorkspace()
	const { data: bets, isLoading: betsLoading } = useBets(workspaceId)
	const { data: tasks, isLoading: tasksLoading } = useObjects(workspaceId, { type: 'task' })
	const { data: sessions, isLoading: sessionsLoading } = useWorkspaceSessions(workspaceId)
	const { data: actors, isLoading: actorsLoading } = useActors(workspaceId)
	const { data: relationships, isLoading: relsLoading } = useRelationships(workspaceId)

	const isLoading = betsLoading || tasksLoading || sessionsLoading || actorsLoading || relsLoading

	const activeBets = useMemo(
		() => (bets ?? []).filter((b) => ACTIVE_BET_STATUSES.has(b.status)),
		[bets],
	)

	const proposedBets = useMemo(
		() => (bets ?? []).filter((b) => PROPOSED_BET_STATUSES.has(b.status)),
		[bets],
	)

	const inProgressTasks = useMemo(
		() => (tasks ?? []).filter((t) => t.status === 'in_progress'),
		[tasks],
	)

	const todoTasks = useMemo(() => (tasks ?? []).filter((t) => t.status === 'todo'), [tasks])

	const activeSessions = useMemo(
		() => (sessions ?? []).filter((s) => ACTIVE_SESSION_STATUSES.has(s.status)),
		[sessions],
	)

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions ?? []), [sessions])

	const agents = useMemo(() => (actors ?? []).filter((a) => a.type === 'agent'), [actors])

	const workingAgents = useMemo(
		() => agents.filter((a) => deriveAgentStatus(a.id, sessionsByAgent) === 'working'),
		[agents, sessionsByAgent],
	)

	const flowCounts = useMemo(() => {
		const allBets = bets ?? []
		return {
			proposed: allBets.filter((b) => PROPOSED_BET_STATUSES.has(b.status)).length,
			active: allBets.filter((b) => ACTIVE_BET_STATUSES.has(b.status)).length,
			completed: allBets.filter((b) => COMPLETED_BET_STATUSES.has(b.status)).length,
		}
	}, [bets])

	if (isLoading) {
		return (
			<div className="space-y-6">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	const hasActivity =
		activeBets.length > 0 || activeSessions.length > 0 || inProgressTasks.length > 0
	const hasUpcoming = proposedBets.length > 0 || todoTasks.length > 0

	if (!hasActivity && !hasUpcoming) {
		return (
			<EmptyState
				title="Nothing happening yet"
				description="Create a bet to get started. Agents will work on tasks and show up here."
			/>
		)
	}

	return (
		<div className="space-y-8">
			{/* In Progress */}
			<InProgressSection
				bets={activeBets}
				tasks={inProgressTasks}
				sessions={activeSessions}
				workingAgents={workingAgents}
				sessionsByAgent={sessionsByAgent}
				relationships={relationships ?? []}
				workspaceId={workspaceId}
			/>

			{/* Up Next */}
			{hasUpcoming && (
				<UpNextSection
					bets={proposedBets}
					tasks={todoTasks}
					relationships={relationships ?? []}
					workspaceId={workspaceId}
				/>
			)}

			{/* Flow Overview */}
			<FlowOverview counts={flowCounts} />
		</div>
	)
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
	return (
		<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
			{title}
			{count !== undefined && count > 0 && <span className="ml-1.5 text-foreground">{count}</span>}
		</h2>
	)
}

function InProgressSection({
	bets,
	tasks,
	sessions,
	workingAgents,
	sessionsByAgent,
	relationships,
	workspaceId,
}: {
	bets: ObjectResponse[]
	tasks: ObjectResponse[]
	sessions: SessionResponse[]
	workingAgents: ActorListItem[]
	sessionsByAgent: Map<string, Array<{ actorId: string; status: string; createdAt: string | null }>>
	relationships: RelationshipResponse[]
	workspaceId: string
}) {
	const totalItems = bets.length + sessions.length
	if (totalItems === 0 && tasks.length === 0 && workingAgents.length === 0) return null

	return (
		<section className="space-y-4">
			<SectionHeader title="In Progress" count={bets.length + tasks.length} />

			{/* Working agents */}
			{workingAgents.length > 0 && (
				<div className="space-y-2">
					{workingAgents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent as ActorResponse}
							status="working"
							latestSession={
								getLatestSession(agent.id, sessionsByAgent) as SessionResponse | undefined
							}
						/>
					))}
				</div>
			)}

			{/* Active bets with progress */}
			{bets.length > 0 && (
				<div className="space-y-2">
					{bets.map((bet) => {
						const betTasks = relationships.filter(
							(r) => r.sourceId === bet.id && r.type === 'breaks_into',
						)
						const betTaskIds = new Set(betTasks.map((r) => r.targetId))
						const insightCount = relationships.filter(
							(r) => r.targetId === bet.id && r.type === 'informs',
						).length

						return (
							<BetWithProgress
								key={bet.id}
								bet={bet}
								taskIds={betTaskIds}
								insightCount={insightCount}
								taskCount={betTasks.length}
								workspaceId={workspaceId}
								activeSessions={sessions}
							/>
						)
					})}
				</div>
			)}

			{/* Standalone in-progress tasks (not covered by active bets) */}
			{tasks.length > 0 && (
				<div className="space-y-2">
					{tasks.slice(0, 5).map((task) => (
						<TaskItem key={task.id} task={task} workspaceId={workspaceId} />
					))}
					{tasks.length > 5 && (
						<p className="text-xs text-muted-foreground pl-1">
							+{tasks.length - 5} more in progress
						</p>
					)}
				</div>
			)}
		</section>
	)
}

function BetWithProgress({
	bet,
	taskIds,
	insightCount,
	taskCount,
	workspaceId,
	activeSessions,
}: {
	bet: ObjectResponse
	taskIds: Set<string>
	insightCount: number
	taskCount: number
	workspaceId: string
	activeSessions: SessionResponse[]
}) {
	const activeSessionsForBet = activeSessions.filter(
		(s) => taskIds.size > 0 && ACTIVE_SESSION_STATUSES.has(s.status),
	)

	return (
		<div className="space-y-1">
			<BetCard
				bet={bet}
				workspaceId={workspaceId}
				insightCount={insightCount}
				taskCount={taskCount}
			/>
			{activeSessionsForBet.length > 0 && (
				<p className="text-xs text-accent pl-4">
					{activeSessionsForBet.length} active session{activeSessionsForBet.length !== 1 ? 's' : ''}
				</p>
			)}
		</div>
	)
}

function TaskItem({ task, workspaceId }: { task: ObjectResponse; workspaceId: string }) {
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: task.id }}
			className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:border-border-hover transition-colors"
		>
			<div className="flex items-center gap-2 min-w-0">
				<span className="text-sm text-foreground truncate">{task.title || 'Untitled task'}</span>
				<StatusBadge status={task.status} />
			</div>
			{task.updatedAt && (
				<RelativeTime
					date={task.updatedAt}
					className="text-xs text-muted-foreground shrink-0 ml-2"
				/>
			)}
		</Link>
	)
}

function UpNextSection({
	bets,
	tasks,
	relationships,
	workspaceId,
}: {
	bets: ObjectResponse[]
	tasks: ObjectResponse[]
	relationships: RelationshipResponse[]
	workspaceId: string
}) {
	return (
		<section className="space-y-4">
			<SectionHeader title="Up Next" count={bets.length + tasks.length} />

			{bets.length > 0 && (
				<div className="space-y-2">
					{bets.map((bet) => {
						const insightCount = relationships.filter(
							(r) => r.targetId === bet.id && r.type === 'informs',
						).length
						const taskCount = relationships.filter(
							(r) => r.sourceId === bet.id && r.type === 'breaks_into',
						).length

						return (
							<BetCard
								key={bet.id}
								bet={bet}
								workspaceId={workspaceId}
								insightCount={insightCount}
								taskCount={taskCount}
							/>
						)
					})}
				</div>
			)}

			{tasks.length > 0 && (
				<div className="space-y-2">
					{tasks.slice(0, 5).map((task) => (
						<TaskItem key={task.id} task={task} workspaceId={workspaceId} />
					))}
					{tasks.length > 5 && (
						<p className="text-xs text-muted-foreground pl-1">+{tasks.length - 5} more to do</p>
					)}
				</div>
			)}
		</section>
	)
}

function FlowOverview({
	counts,
}: { counts: { proposed: number; active: number; completed: number } }) {
	const total = counts.proposed + counts.active + counts.completed
	if (total === 0) return null

	return (
		<section className="space-y-4">
			<SectionHeader title="Flow" />
			<div className="flex items-center gap-2">
				<FlowStage label="Proposed" count={counts.proposed} />
				<FlowArrow />
				<FlowStage label="Active" count={counts.active} highlight />
				<FlowArrow />
				<FlowStage label="Completed" count={counts.completed} />
			</div>
		</section>
	)
}

function FlowStage({
	label,
	count,
	highlight,
}: { label: string; count: number; highlight?: boolean }) {
	return (
		<div
			className={`flex-1 rounded-lg border px-4 py-3 text-center ${
				highlight ? 'border-accent bg-accent/5' : 'border-border bg-card'
			}`}
		>
			<p className={`text-lg font-semibold ${highlight ? 'text-accent' : 'text-foreground'}`}>
				{count}
			</p>
			<p className="text-xs text-muted-foreground">{label}</p>
		</div>
	)
}

function FlowArrow() {
	return <span className="text-muted-foreground text-sm">→</span>
}
