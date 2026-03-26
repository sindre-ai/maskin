import { AgentCard } from '@/components/agents/agent-card'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: events } = useEvents(workspaceId, { limit: '100' })

	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	// Map each agent to their most recent event
	const lastEventByActor = new Map<
		string,
		typeof events extends (infer T)[] | undefined ? T : never
	>()
	for (const event of events ?? []) {
		if (!lastEventByActor.has(event.actorId)) {
			lastEventByActor.set(event.actorId, event)
		}
	}

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
				<div className="grid gap-4 md:grid-cols-2">
					{agents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent as ActorResponse}
							lastEvent={lastEventByActor.get(agent.id)}
						/>
					))}
				</div>
			)}
		</div>
	)
}
