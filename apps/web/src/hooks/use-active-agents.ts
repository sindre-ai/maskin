import { useActors } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { RUNNING_STATUSES, getActiveAgentSessions } from '@/lib/agent-status'
import { useMemo } from 'react'

export interface ActiveAgent {
	actorId: string
	name: string
	type: string
	sessionId: string
	currentActivity: string | null
	startedAt: string | null
}

// Only sessions that are executing count. Pending and starting sessions are
// waiting for a slot (a burst of retries can leave dozens there), so counting
// them made the sidebar claim far more work than was running.
export function useActiveAgents(workspaceId: string) {
	const sessionsQuery = useWorkspaceSessions(workspaceId)
	const actorsQuery = useActors(workspaceId, { enabled: !!workspaceId })

	const agents = useMemo<ActiveAgent[]>(() => {
		if (!sessionsQuery.data) return []
		const active = getActiveAgentSessions(sessionsQuery.data, RUNNING_STATUSES)
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

	// `agents` is one row per *agent* — getActiveAgentSessions collapses an
	// actor's live sessions down to its most recent one — so it cannot answer
	// "how many sessions are running". That count has to come off the raw list.
	const activeSessionCount = useMemo(
		() => (sessionsQuery.data ?? []).filter((s) => RUNNING_STATUSES.has(s.status)).length,
		[sessionsQuery.data],
	)

	return {
		agents,
		activeSessionCount,
		isLoading: sessionsQuery.isLoading,
		isError: sessionsQuery.isError,
	}
}
