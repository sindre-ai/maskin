import { AgentCreateForm } from '@/components/agents/agent-create-form'
import { AgentDocument } from '@/components/agents/agent-document'
import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActor, useAgent, useCreateActor } from '@/hooks/use-actors'
import { api } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/agents/$agentId')({
	component: AgentDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function AgentDetailPage() {
	const { agentId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	// Use list-derived hook to check existence (returns undefined for new IDs, no 404)
	const { data: agentListItem, isLoading } = useAgent(agentId, workspaceId)
	const createActor = useCreateActor(workspaceId)
	const isCreatedRef = useRef(false)

	// Once the agent exists in the list, mark as created
	useEffect(() => {
		if (agentListItem) isCreatedRef.current = true
	}, [agentListItem])
	const isCreated = isCreatedRef.current || !!agentListItem

	if (isLoading && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	const handleAutoCreate = async (data: { name: string }) => {
		if (isCreatedRef.current) return
		isCreatedRef.current = true
		try {
			await createActor.mutateAsync({
				id: agentId,
				type: 'agent',
				name: data.name,
			})
			// Auto-add agent to workspace members
			try {
				await api.workspaces.members.add(workspaceId, {
					actor_id: agentId,
					role: 'member',
				})
			} catch {
				// workspace membership may already exist
			}
			toast.success('Agent created')
		} catch {
			isCreatedRef.current = false
		}
	}

	// Once created, render the full document editor (fetches full detail)
	if (isCreated) {
		return <AgentDetailLoaded agentId={agentId} />
	}

	// Create mode — show minimal form
	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto">
				<AgentCreateForm
					onAutoCreate={handleAutoCreate}
					isPending={createActor.isPending}
					error={createActor.error}
				/>
			</div>
		</>
	)
}

/** Fetches the full agent detail and renders the document editor. */
function AgentDetailLoaded({ agentId }: { agentId: string }) {
	const { data: agent, isLoading } = useActor(agentId)

	if (isLoading || !agent) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	return <AgentDocument agent={agent} />
}
