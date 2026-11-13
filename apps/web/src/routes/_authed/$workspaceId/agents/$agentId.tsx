import { AgentCreateForm } from '@/components/agents/agent-create-form'
import { AgentDetailView } from '@/components/agents/agent-detail-view'
import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { useActor, useAgent, useCreateActor, useUpdateActor } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { type AgentTab, DEFAULT_AGENT_TAB, parseAgentTab } from '@/lib/agent-detail'
import { trackAgentOpened } from '@/lib/analytics'
import { ApiError } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/agents/$agentId')({
	component: AgentDetailPage,
	// `?tab=sessions` opens a tab directly; anything else (the retired `overview` too) is Setup.
	validateSearch: (search: Record<string, unknown>): { tab?: AgentTab } => ({
		tab: parseAgentTab(search.tab),
	}),
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function AgentDetailPage() {
	const { agentId } = Route.useParams()
	const { tab } = Route.useSearch()
	const navigate = Route.useNavigate()
	const onTabChange = (next: AgentTab) =>
		navigate({ search: { tab: next === DEFAULT_AGENT_TAB ? undefined : next }, replace: true })
	const { workspaceId } = useWorkspace()
	// Use list-derived hook to check existence (returns undefined for new IDs, no 404)
	const { data: agentListItem, isLoading } = useAgent(agentId, workspaceId)
	useDocumentTitle(agentListItem?.name)
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
			<div className="mx-auto w-full max-w-280 space-y-4">
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
				// The server adds the agent to this workspace in the same request.
				workspace_id: workspaceId,
			})
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
		return <AgentDetailLoaded agentId={agentId} tab={tab} onTabChange={onTabChange} />
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
function AgentDetailLoaded({
	agentId,
	tab,
	onTabChange,
}: {
	agentId: string
	tab?: AgentTab
	onTabChange: (tab: AgentTab) => void
}) {
	const { data: agent, isLoading, isError, error, refetch } = useActor(agentId)

	// One event per open of an agent's page. Keyed on the id so refetches and
	// StrictMode's double effect do not repeat it.
	const openedAgentRef = useRef<string | null>(null)
	const loadedAgentId = agent?.id ?? null
	useEffect(() => {
		if (!loadedAgentId || openedAgentRef.current === loadedAgentId) return
		openedAgentRef.current = loadedAgentId
		trackAgentOpened({ entity_id: loadedAgentId })
	}, [loadedAgentId])

	if (isLoading) {
		return (
			<div className="mx-auto w-full max-w-280 space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (isError && !agent) {
		const is404 = error instanceof ApiError && error.status === 404
		return (
			<div className="mx-auto w-full max-w-280">
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
			<div className="mx-auto w-full max-w-280 space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	return <AgentDetailView agent={agent} tab={tab ?? DEFAULT_AGENT_TAB} onTabChange={onTabChange} />
}
