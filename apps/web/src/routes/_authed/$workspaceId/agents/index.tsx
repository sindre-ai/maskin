import {
	AgentPortraitCard,
	type PortraitStatus,
	getPortraitStatus,
	portraitStatusToFilter,
} from '@/components/agents/agent-portrait-card'
import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useActors, useAgentPause, useAgentRun } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

type StatusFilter = 'all' | 'working' | 'idle' | 'failed'

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
	const [createPickerOpen, setCreatePickerOpen] = useState(false)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

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

	const tabs: { label: string; value: StatusFilter; count: number }[] = [
		{ label: 'All', value: 'all', count: counts.all },
		{ label: 'Working', value: 'working', count: counts.working },
		{ label: 'Idle', value: 'idle', count: counts.idle },
		{ label: 'Failed', value: 'failed', count: counts.failed },
	]

	const newButton = (
		<Button size="sm" className="gap-1.5" onClick={() => setCreatePickerOpen(true)}>
			<Plus size={14} />
			New
		</Button>
	)

	if (isLoading) {
		return (
			<div>
				<PageHeader title="Agents" actions={newButton} />
				<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
					<CardSkeleton />
					<CardSkeleton />
					<CardSkeleton />
				</div>
				<CreatePicker
					open={createPickerOpen}
					onOpenChange={setCreatePickerOpen}
					defaultType="agent"
				/>
			</div>
		)
	}

	return (
		<div>
			<PageHeader title="Agents" actions={newButton} />

			{agents.length === 0 ? (
				<EmptyState
					title="No agents in this workspace"
					description="Create an agent to get started with automation"
				/>
			) : (
				<>
					<FilterTabs
						tabs={tabs}
						value={statusFilter}
						onChange={setStatusFilter}
						aria-label="Agent status filter"
						className="mb-4"
					/>

					<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
						{filtered.map((agent) => (
							<AgentPortraitCardItem
								key={agent.id}
								workspaceId={workspaceId}
								agent={agent as ActorResponse}
								status={portraitStatuses.get(agent.id) ?? 'idle'}
								latestSession={getLatestSession(agent.id, sessionsByAgent)}
							/>
						))}
					</div>
				</>
			)}
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="agent"
			/>
		</div>
	)
}

function AgentPortraitCardItem({
	workspaceId,
	agent,
	status,
	latestSession,
}: {
	workspaceId: string
	agent: ActorResponse
	status: PortraitStatus
	latestSession?: SessionResponse
}) {
	// One mutation instance per card — sharing a single instance across the grid
	// meant clicking Run/Pause on one agent detached the previous card's mutation
	// (TanStack Query observers detach on `.mutate()`), silently dropping its
	// onError toast and pending state if another agent was actioned first.
	const runMutation = useAgentRun(workspaceId)
	const pauseMutation = useAgentPause(workspaceId)

	return (
		<AgentPortraitCard
			agent={agent}
			status={status}
			latestSession={latestSession}
			onRun={() =>
				runMutation.mutate(
					{ id: agent.id },
					{ onError: () => toast.error(`Couldn't start ${agent.name}`) },
				)
			}
			onPause={() =>
				pauseMutation.mutate(agent.id, {
					onError: () => toast.error(`Couldn't pause ${agent.name}`),
				})
			}
			isRunPending={runMutation.isPending}
			isPausePending={pauseMutation.isPending}
		/>
	)
}
