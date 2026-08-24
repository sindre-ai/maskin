import { AgentCreateForm } from '@/components/agents/agent-create-form'
import { AgentDetailView } from '@/components/agents/agent-detail-view'
import { AgentDocument } from '@/components/agents/agent-document'
import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { useActor, useAgent, useCreateActor, useUpdateActor } from '@/hooks/use-actors'
import { ApiError, api } from '@/lib/api'
import { useNewDesign } from '@/lib/new-design-context'
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
	const updateActor = useUpdateActor(workspaceId)
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
				<Skeleton className="h-4 w-full max-w-96" />
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
			// Auto-add agent to workspace members. A conflict means the membership
			// already exists, which is the one benign outcome — anything else (403,
			// 404, 5xx, network) leaves an agent that is not a workspace member, so
			// it must be surfaced rather than swallowed under a success toast.
			try {
				await api.workspaces.members.add(workspaceId, {
					actor_id: agentId,
					role: 'member',
				})
			} catch (err) {
				const isDuplicate = err instanceof ApiError && (err.status === 409 || err.status === 400)
				if (!isDuplicate) {
					toast.error(
						`Agent created, but adding it to the workspace failed: ${
							err instanceof Error ? err.message : 'unknown error'
						}`,
					)
					return
				}
			}
			toast.success('Agent created')
		} catch {
			// The create itself failed. Allow a retry, and let the error surface
			// through `createActor.error`, which AgentCreateForm renders inline.
			isCreatedRef.current = false
		}
	}

	const handleUpdate = (data: Record<string, unknown>) => {
		updateActor.mutate(
			{ id: agentId, data },
			{ onError: () => toast.error("Couldn't save that change") },
		)
	}

	// Once created, render the full document editor (fetches full detail)
	if (isCreated) {
		return <AgentDetailLoaded agentId={agentId} />
	}

	// Create mode — show form with all sections
	return (
		<>
			<PageHeader />
			<AgentCreateForm
				onAutoCreate={handleAutoCreate}
				onUpdate={handleUpdate}
				agent={agentListItem}
				isPending={createActor.isPending}
				error={createActor.error}
			/>
		</>
	)
}

/** Fetches the full agent detail and renders the document editor. */
function AgentDetailLoaded({ agentId }: { agentId: string }) {
	// The `new-design` boundary for agent detail — v2 sections vs the pre-v2
	// document editor. Resolved boolean only; the flag is read at the shell.
	const newDesign = useNewDesign()
	const { data: agent, isLoading, isError, error, refetch } = useActor(agentId)

	if (isLoading) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (isError && !agent) {
		const is404 = error instanceof ApiError && error.status === 404
		return (
			<div className="max-w-3xl mx-auto">
				<QueryStateError
					title={is404 ? 'Agent not found' : "Couldn't load this agent"}
					error={error ?? new Error('Something went wrong.')}
					onRetry={() => refetch()}
				/>
			</div>
		)
	}

	if (!agent) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	return newDesign ? <AgentDetailView agent={agent} /> : <AgentDocument agent={agent} />
}
