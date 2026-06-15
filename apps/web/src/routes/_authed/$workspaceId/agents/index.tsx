import { AgentCard, type AgentStatus } from '@/components/agents/agent-card'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

type StatusFilter = 'all' | AgentStatus

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

	// New agent persists once a name is entered on its detail page (matches the
	// global "+" menu flow).
	const handleNewAgent = useCallback(() => {
		navigate({
			to: '/$workspaceId/agents/$agentId',
			params: { workspaceId, agentId: crypto.randomUUID() },
		})
	}, [navigate, workspaceId])

	const newAgentAction = (
		<Button size="sm" className="gap-1.5" onClick={handleNewAgent}>
			<Plus size={14} />
			New agent
		</Button>
	)

	const agents = useMemo(() => (actors ?? []).filter((a) => a.type === 'agent'), [actors])

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions ?? []), [sessions])

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

	const tabs: { label: string; value: StatusFilter; count: number }[] = [
		{ label: 'All', value: 'all', count: counts.all },
		{ label: 'Working', value: 'working', count: counts.working },
		{ label: 'Idle', value: 'idle', count: counts.idle },
		{ label: 'Failed', value: 'failed', count: counts.failed },
	]

	if (isLoading) {
		return (
			<div>
				<PageHeader title="Agents" actions={newAgentAction} />
				<div className="grid gap-4 md:grid-cols-2">
					<CardSkeleton />
					<CardSkeleton />
				</div>
			</div>
		)
	}

	return (
		<div>
			<PageHeader title="Agents" actions={newAgentAction} />

			{agents.length === 0 ? (
				<EmptyState
					title="No agents in this workspace"
					description="Agents automate work by responding to triggers and running sessions. Create your first agent to get started."
					action={newAgentAction}
				/>
			) : (
				<>
					<FilterTabs
						aria-label="Agent status"
						className="mb-4"
						tabs={tabs}
						value={statusFilter}
						onChange={setStatusFilter}
					/>

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
