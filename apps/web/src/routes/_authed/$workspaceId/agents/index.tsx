import {
	AgentPortraitCard,
	getPortraitStatus,
	portraitStatusToFilter,
} from '@/components/agents/agent-portrait-card'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors, useAgentPause, useAgentRun } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

type StatusFilter = 'all' | 'working' | 'idle' | 'failed'

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const runMutation = useAgentRun(workspaceId)
	const pauseMutation = useAgentPause(workspaceId)
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

	const agents = useMemo(() => (actors ?? []).filter((a) => a.type === 'agent'), [actors])

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions ?? []), [sessions])

	const portraitStatuses = useMemo(() => {
		const map = new Map<string, ReturnType<typeof getPortraitStatus>>()
		for (const agent of agents) {
			const sessionStatus = deriveAgentStatus(agent.id, sessionsByAgent)
			map.set(agent.id, getPortraitStatus(agent, sessionStatus))
		}
		return map
	}, [agents, sessionsByAgent])

	const counts = useMemo(() => {
		const c: Record<StatusFilter, number> = {
			all: agents.length,
			working: 0,
			idle: 0,
			failed: 0,
		}
		for (const status of portraitStatuses.values()) {
			c[portraitStatusToFilter(status)]++
		}
		return c
	}, [agents.length, portraitStatuses])

	const filtered = useMemo(
		() =>
			statusFilter === 'all'
				? agents
				: agents.filter(
						(a) => portraitStatusToFilter(portraitStatuses.get(a.id) ?? 'idle') === statusFilter,
					),
		[agents, statusFilter, portraitStatuses],
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
				<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
					<CardSkeleton />
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

					<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
						{filtered.map((agent) => {
							const status = portraitStatuses.get(agent.id) ?? 'idle'
							const runVars = runMutation.variables
							const pauseVars = pauseMutation.variables
							return (
								<AgentPortraitCard
									key={agent.id}
									agent={agent as ActorResponse}
									status={status}
									latestSession={getLatestSession(agent.id, sessionsByAgent)}
									onRun={() => runMutation.mutate({ id: agent.id })}
									onPause={() => pauseMutation.mutate(agent.id)}
									isRunPending={runMutation.isPending && runVars?.id === agent.id}
									isPausePending={pauseMutation.isPending && pauseVars === agent.id}
								/>
							)
						})}
					</div>
				</>
			)}
		</div>
	)
}
