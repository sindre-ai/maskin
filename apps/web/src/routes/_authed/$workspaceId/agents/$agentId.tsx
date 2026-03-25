import { AgentDocument } from '@/components/agents/agent-document'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActor } from '@/hooks/use-actors'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/agents/$agentId')({
	component: AgentDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function AgentDetailPage() {
	const { agentId } = Route.useParams()
	const { data: agent, isLoading, error } = useActor(agentId)

	if (isLoading) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (error || !agent) {
		return (
			<div className="flex items-center justify-center py-16">
				<p className="text-sm text-muted-foreground">{error?.message || 'Agent not found'}</p>
			</div>
		)
	}

	return <AgentDocument agent={agent} />
}
