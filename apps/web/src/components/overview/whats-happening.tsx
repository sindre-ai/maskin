import { AgentCard } from '@/components/agents/agent-card'
import { BetCard } from '@/components/bets/bet-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { useActors } from '@/hooks/use-actors'
import { useBets } from '@/hooks/use-bets'
import { useEvents } from '@/hooks/use-events'
import { useObjects } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import type {
	ActorListItem,
	ActorResponse,
	EventResponse,
	ObjectResponse,
	RelationshipResponse,
	SessionResponse,
} from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
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
	const { data: events } = useEvents(workspaceId, { limit: '100' })
	const currentActor = getStoredActor()

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

	// ─── My Work ──────────────────────────────────────────────────────────────
	// Build object ID sets from the relationships edge table, then resolve to
	// objects loaded alongside bets + tasks. Memoised so the sections don't
	// rebuild on every render.
	const myObjectIds = useMemo(() => {
		const assigned = new Set<string>()
		const watching = new Set<string>()
		if (!currentActor) return { assigned, watching }
		for (const rel of relationships ?? []) {
			if (rel.targetType !== 'actor' || rel.targetId !== currentActor.id) continue
			if (rel.sourceType === 'actor') continue
			if (rel.type === 'assigned_to') assigned.add(rel.sourceId)
			else if (rel.type === 'watches') watching.add(rel.sourceId)
		}
		return { assigned, watching }
	}, [relationships, currentActor])

	const myAssigned = useMemo(() => {
		const pool = [...(bets ?? []), ...(tasks ?? [])]
		return pool.filter((o) => myObjectIds.assigned.has(o.id))
	}, [bets, tasks, myObjectIds])

	const myWatching = useMemo(() => {
		const pool = [...(bets ?? []), ...(tasks ?? [])]
		return pool.filter((o) => myObjectIds.watching.has(o.id))
	}, [bets, tasks, myObjectIds])

	const myMentions = useMemo(() => {
		if (!currentActor || !events) return []
		const pool = [...(bets ?? []), ...(tasks ?? [])]
		const byId = new Map(pool.map((o) => [o.id, o]))
		const seen = new Set<string>()
		const hits: { event: EventResponse; object: ObjectResponse }[] = []
		for (const event of events) {
			if (event.action !== 'commented') continue
			const data = event.data as { mentions?: string[] } | null
			if (!data?.mentions?.includes(currentActor.id)) continue
			const object = byId.get(event.entityId)
			if (!object || seen.has(object.id)) continue
			seen.add(object.id)
			hits.push({ event, object })
		}
		return hits
	}, [events, bets, tasks, currentActor])

	const hasMyWork = myAssigned.length > 0 || myWatching.length > 0 || myMentions.length > 0

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

	if (!hasActivity && !hasUpcoming && !hasMyWork) {
		return (
			<EmptyState
				title="Nothing happening yet"
				description="Create a bet to get started. Agents will work on tasks and show up here."
			/>
		)
	}

	return (
		<div className="space-y-8">
			{/* My Work — objects the current actor is responsible for or watching */}
			{hasMyWork && (
				<MyWorkSection
					assigned={myAssigned}
					watching={myWatching}
					mentions={myMentions}
					relationships={relationships ?? []}
					workspaceId={workspaceId}
				/>
			)}

			{/* In Progress */}
			<InProgressSection
				bets={activeBets}
				tasks={inProgressTasks}
				allTasks={tasks ?? []}
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
	allTasks,
	sessions,
	workingAgents,
	sessionsByAgent,
	relationships,
	workspaceId,
}: {
	bets: ObjectResponse[]
	tasks: ObjectResponse[]
	allTasks: ObjectResponse[]
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
								allTasks={allTasks}
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
	allTasks,
	activeSessions,
}: {
	bet: ObjectResponse
	taskIds: Set<string>
	insightCount: number
	taskCount: number
	workspaceId: string
	allTasks: ObjectResponse[]
	activeSessions: SessionResponse[]
}) {
	const activeSessionIds = useMemo(() => new Set(activeSessions.map((s) => s.id)), [activeSessions])
	const activeSessionCount = useMemo(
		() =>
			allTasks.filter(
				(t) => taskIds.has(t.id) && t.activeSessionId && activeSessionIds.has(t.activeSessionId),
			).length,
		[allTasks, taskIds, activeSessionIds],
	)

	return (
		<div className="space-y-1">
			<BetCard
				bet={bet}
				workspaceId={workspaceId}
				insightCount={insightCount}
				taskCount={taskCount}
			/>
			{activeSessionCount > 0 && (
				<p className="text-xs text-accent pl-4">
					{activeSessionCount} active session{activeSessionCount !== 1 ? 's' : ''}
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

function MyWorkSection({
	assigned,
	watching,
	mentions,
	relationships,
	workspaceId,
}: {
	assigned: ObjectResponse[]
	watching: ObjectResponse[]
	mentions: { event: EventResponse; object: ObjectResponse }[]
	relationships: RelationshipResponse[]
	workspaceId: string
}) {
	const totalCount = assigned.length + watching.length + mentions.length
	return (
		<section className="space-y-4">
			<SectionHeader title="My Work" count={totalCount} />

			{assigned.length > 0 && (
				<MyWorkGroup
					label="Assigned to you"
					objects={assigned}
					relationships={relationships}
					workspaceId={workspaceId}
				/>
			)}

			{watching.length > 0 && (
				<MyWorkGroup
					label="Watching"
					objects={watching}
					relationships={relationships}
					workspaceId={workspaceId}
				/>
			)}

			{mentions.length > 0 && (
				<div className="space-y-2">
					<p className="text-xs font-medium text-muted-foreground pl-1">Mentioned</p>
					<div className="space-y-2">
						{mentions.slice(0, 5).map(({ object }) => {
							if (object.type === 'bet') {
								const insightCount = relationships.filter(
									(r) => r.targetId === object.id && r.type === 'informs',
								).length
								const taskCount = relationships.filter(
									(r) => r.sourceId === object.id && r.type === 'breaks_into',
								).length
								return (
									<BetCard
										key={object.id}
										bet={object}
										workspaceId={workspaceId}
										insightCount={insightCount}
										taskCount={taskCount}
									/>
								)
							}
							return <TaskItem key={object.id} task={object} workspaceId={workspaceId} />
						})}
						{mentions.length > 5 && (
							<p className="text-xs text-muted-foreground pl-1">
								+{mentions.length - 5} more mentions
							</p>
						)}
					</div>
				</div>
			)}
		</section>
	)
}

function MyWorkGroup({
	label,
	objects,
	relationships,
	workspaceId,
}: {
	label: string
	objects: ObjectResponse[]
	relationships: RelationshipResponse[]
	workspaceId: string
}) {
	const bets = objects.filter((o) => o.type === 'bet')
	const rest = objects.filter((o) => o.type !== 'bet')

	return (
		<div className="space-y-2">
			<p className="text-xs font-medium text-muted-foreground pl-1">{label}</p>
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
				{rest.slice(0, 5).map((obj) => (
					<TaskItem key={obj.id} task={obj} workspaceId={workspaceId} />
				))}
				{rest.length > 5 && (
					<p className="text-xs text-muted-foreground pl-1">+{rest.length - 5} more</p>
				)}
			</div>
		</div>
	)
}
