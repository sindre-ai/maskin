import { AgentCard, type AgentStatus } from '@/components/agents/agent-card'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const ACTIVE_STATUSES = new Set(['running', 'starting', 'pending'])

type StatusFilter = 'all' | AgentStatus

function deriveAgentStatus(
	agentId: string,
	sessionsByAgent: Map<string, SessionResponse[]>,
): AgentStatus {
	const sessions = sessionsByAgent.get(agentId)
	if (!sessions?.length) return 'idle'

	const hasActive = sessions.some((s) => ACTIVE_STATUSES.has(s.status))
	if (hasActive) return 'working'

	const latest = sessions[0] // already sorted by createdAt desc
	if (latest.status === 'failed' || latest.status === 'timeout') return 'failed'

	return 'idle'
}

function getLatestSession(
	agentId: string,
	sessionsByAgent: Map<string, SessionResponse[]>,
): SessionResponse | undefined {
	const sessions = sessionsByAgent.get(agentId)
	if (!sessions?.length) return undefined

	// If working, return the active session
	const active = sessions.find((s) => ACTIVE_STATUSES.has(s.status))
	if (active) return active

	// Otherwise return most recent
	return sessions[0]
}

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

	const agents = useMemo(
		() => (actors ?? []).filter((a) => a.type === 'agent'),
		[actors],
	)

	// Group sessions by actorId
	const sessionsByAgent = useMemo(() => {
		const map = new Map<string, SessionResponse[]>()
		for (const session of sessions ?? []) {
			const list = map.get(session.actorId) ?? []
			list.push(session)
			map.set(session.actorId, list)
		}
		return map
	}, [sessions])

	// Compute status for each agent
	const agentStatuses = useMemo(() => {
		const map = new Map<string, AgentStatus>()
		for (const agent of agents) {
			map.set(agent.id, deriveAgentStatus(agent.id, sessionsByAgent))
		}
		return map
	}, [agents, sessionsByAgent])

	// Count by status
	const counts = useMemo(() => {
		const c = { all: agents.length, working: 0, idle: 0, failed: 0 }
		for (const status of agentStatuses.values()) {
			c[status]++
		}
		return c
	}, [agents.length, agentStatuses])

	// Filter
	const filtered = useMemo(
		() =>
			statusFilter === 'all'
				? agents
				: agents.filter((a) => agentStatuses.get(a.id) === statusFilter),
		[agents, statusFilter, agentStatuses],
	)

	const tabs: { label: string; value: StatusFilter }[] = [
		{ label: 'All', value: 'all' },
		{ label: 'Working', value: 'working' },
		{ label: 'Idle', value: 'idle' },
		{ label: 'Failed', value: 'failed' },
	]

	if (isLoading) {
		return (
			<div>
				<PageHeader title="Agents" />
				<div className="grid gap-4 md:grid-cols-2">
					<CardSkeleton />
					<CardSkeleton />
				</div>
			</div>
		)
	}

	return (
		<div>
			<PageHeader title="Agents" />

			{agents.length === 0 ? (
				<EmptyState
					title="No agents in this workspace"
					description="Create an agent to get started with automation"
				/>
			) : (
				<>
					<div className="flex gap-1 mb-4">
						{tabs.map((tab) => (
							<button
								key={tab.value}
								type="button"
								className={cn(
									'rounded px-3 py-1 text-sm',
									statusFilter === tab.value
										? 'bg-muted text-foreground font-medium'
										: 'text-muted-foreground hover:text-foreground',
								)}
								onClick={() => setStatusFilter(tab.value)}
							>
								{tab.label} ({counts[tab.value]})
							</button>
						))}
					</div>

					<div className="grid gap-4 md:grid-cols-2">
						{filtered.map((agent) => (
							<AgentCard
								key={agent.id}
								agent={agent as ActorResponse}
								status={agentStatuses.get(agent.id) ?? 'idle'}
								latestSession={getLatestSession(agent.id, sessionsByAgent)}
							/>
						))}
					</div>
				</>
			)}
		</div>
	)
}
