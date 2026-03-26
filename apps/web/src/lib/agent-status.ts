import type { AgentStatus } from '@/components/agents/agent-card'

interface SessionLike {
	actorId: string
	status: string
	createdAt: string | null
}

const ACTIVE_STATUSES = new Set(['running', 'starting', 'pending'])

export function groupSessionsByAgent<T extends SessionLike>(sessions: T[]): Map<string, T[]> {
	const map = new Map<string, T[]>()
	for (const session of sessions) {
		const list = map.get(session.actorId) ?? []
		list.push(session)
		map.set(session.actorId, list)
	}
	for (const list of map.values()) {
		list.sort(
			(a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
		)
	}
	return map
}

export function deriveAgentStatus(
	agentId: string,
	sessionsByAgent: Map<string, SessionLike[]>,
): AgentStatus {
	const sessions = sessionsByAgent.get(agentId)
	if (!sessions?.length) return 'idle'

	const hasActive = sessions.some((s) => ACTIVE_STATUSES.has(s.status))
	if (hasActive) return 'working'

	const latest = sessions[0]
	if (latest.status === 'failed' || latest.status === 'timeout') return 'failed'

	return 'idle'
}

export function getLatestSession<T extends SessionLike>(
	agentId: string,
	sessionsByAgent: Map<string, T[]>,
): T | undefined {
	const sessions = sessionsByAgent.get(agentId)
	if (!sessions?.length) return undefined

	const active = sessions.find((s) => ACTIVE_STATUSES.has(s.status))
	if (active) return active

	return sessions[0]
}
