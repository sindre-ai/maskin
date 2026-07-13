import { useActors } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { getActiveAgentSessions } from '@/lib/agent-status'
import { useMemo } from 'react'

export interface ActiveAgent {
	actorId: string
	name: string
	type: string
	sessionId: string
	currentActivity: string | null
	startedAt: string | null
}

export function useActiveAgents(workspaceId: string) {
	const sessionsQuery = useWorkspaceSessions(workspaceId)
	const actorsQuery = useActors(workspaceId, { enabled: !!workspaceId })

	const agents = useMemo<ActiveAgent[]>(() => {
		if (!sessionsQuery.data) return []
		const active = getActiveAgentSessions(sessionsQuery.data)
		const actorsById = new Map((actorsQuery.data ?? []).map((a) => [a.id, a]))
		return active
			.map((session) => {
				const actor = actorsById.get(session.actorId)
				return {
					actorId: session.actorId,
					name: actor?.name ?? 'Agent',
					type: actor?.type ?? 'agent',
					sessionId: session.id,
					currentActivity: session.currentActivity,
					startedAt: session.startedAt,
				}
			})
			.sort((a, b) => {
				const at = new Date(a.startedAt ?? 0).getTime()
				const bt = new Date(b.startedAt ?? 0).getTime()
				if (bt !== at) return bt - at
				return a.name.localeCompare(b.name)
			})
	}, [sessionsQuery.data, actorsQuery.data])

	return {
		agents,
		isLoading: sessionsQuery.isLoading,
		isError: sessionsQuery.isError,
	}
}
