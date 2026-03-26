import { AgentCard } from '@/components/agents/agent-card'
import { CreateAgentDialog } from '@/components/agents/create-agent-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import { useSessions } from '@/hooks/use-sessions'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === 'true' || search.create === true,
	}),
})

type AgentComputedStatus = 'working' | 'idle' | 'failed'
type AgentTab = 'all' | AgentComputedStatus

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: events } = useEvents(workspaceId, { limit: '100' })
	const { data: sessions } = useSessions(workspaceId)
	const { create } = useSearch({ from: '/_authed/$workspaceId/agents/' })
	const [showCreate, setShowCreate] = useState(false)
	const [activeTab, setActiveTab] = useState<AgentTab>('all')

	useEffect(() => {
		if (create) setShowCreate(true)
	}, [create])

	const agents = (actors ?? []).filter((a) => a.type === 'agent') as ActorResponse[]

	// Map each agent to their most recent event
	const lastEventByActor = useMemo(() => {
		const map = new Map<string, typeof events extends (infer T)[] | undefined ? T : never>()
		for (const event of events ?? []) {
			if (!map.has(event.actorId)) {
				map.set(event.actorId, event)
			}
		}
		return map
	}, [events])

	// Compute agent status from sessions
	const agentStatusMap = useMemo(() => {
		const map = new Map<string, AgentComputedStatus>()
		// Group sessions by actorId, latest first (API returns newest first)
		const sessionsByActor = new Map<
			string,
			typeof sessions extends (infer T)[] | undefined ? T[] : never[]
		>()
		for (const session of sessions ?? []) {
			const arr = sessionsByActor.get(session.actorId) ?? []
			arr.push(session)
			sessionsByActor.set(session.actorId, arr)
		}
		for (const [actorId, actorSessions] of sessionsByActor) {
			const hasRunning = actorSessions.some((s) => s.status === 'running' || s.status === 'pending')
			if (hasRunning) {
				map.set(actorId, 'working')
				continue
			}
			const latest = actorSessions[0]
			if (latest && (latest.status === 'failed' || latest.status === 'timeout')) {
				map.set(actorId, 'failed')
				continue
			}
			map.set(actorId, 'idle')
		}
		return map
	}, [sessions])

	const counts = useMemo(
		() => ({
			all: agents.length,
			working: agents.filter((a) => (agentStatusMap.get(a.id) ?? 'idle') === 'working').length,
			idle: agents.filter((a) => (agentStatusMap.get(a.id) ?? 'idle') === 'idle').length,
			failed: agents.filter((a) => (agentStatusMap.get(a.id) ?? 'idle') === 'failed').length,
		}),
		[agents, agentStatusMap],
	)

	const filteredAgents = useMemo(
		() =>
			activeTab === 'all'
				? agents
				: agents.filter((a) => (agentStatusMap.get(a.id) ?? 'idle') === activeTab),
		[agents, activeTab, agentStatusMap],
	)

	const getStatus = (agentId: string): AgentComputedStatus => agentStatusMap.get(agentId) ?? 'idle'

	const TABS: { label: string; value: AgentTab }[] = [
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

			{agents.length > 0 && (
				<div className="flex gap-2 mb-4">
					{TABS.map((tab) => (
						<Button
							key={tab.value}
							variant={activeTab === tab.value ? 'default' : 'outline'}
							size="sm"
							onClick={() => setActiveTab(tab.value)}
						>
							{tab.label} {counts[tab.value]}
						</Button>
					))}
				</div>
			)}

			{filteredAgents.length === 0 ? (
				<EmptyState
					title={agents.length === 0 ? 'No agents in this workspace' : `No ${activeTab} agents`}
					description={
						agents.length === 0 ? 'Create an agent to get started with automation' : undefined
					}
				/>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{filteredAgents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							lastEvent={lastEventByActor.get(agent.id)}
							computedStatus={getStatus(agent.id)}
						/>
					))}
				</div>
			)}
			<CreateAgentDialog
				open={showCreate}
				onClose={() => setShowCreate(false)}
				workspaceId={workspaceId}
			/>
		</div>
	)
}
