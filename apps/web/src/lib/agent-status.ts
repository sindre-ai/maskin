export type AgentStatus = 'working' | 'idle' | 'failed'

interface SessionLike {
	actorId: string
	status: string
	createdAt: string | null
}

export const ACTIVE_STATUSES = new Set(['running', 'starting', 'pending'])

export function getActiveAgentSessions<T extends SessionLike>(sessions: T[]): T[] {
	const active = sessions.filter((s) => ACTIVE_STATUSES.has(s.status))
	const byActor = new Map<string, T>()
	for (const session of active) {
		const existing = byActor.get(session.actorId)
		if (!existing) {
			byActor.set(session.actorId, session)
			continue
		}
		const existingTime = new Date(existing.createdAt ?? 0).getTime()
		const nextTime = new Date(session.createdAt ?? 0).getTime()
		if (nextTime > existingTime) {
			byActor.set(session.actorId, session)
		}
	}
	return Array.from(byActor.values())
}

export function groupSessionsByAgent<T extends SessionLike>(sessions: T[]): Map<string, T[]> {
	const map = new Map<string, T[]>()
	for (const session of sessions) {
		const list = map.get(session.actorId) ?? []
		list.push(session)
		map.set(session.actorId, list)
	}
	for (const list of map.values()) {
		list.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
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

/**
 * Agent kind = the first line of the description (the one-line role label the
 * actors list returns), fallback 'Agent'. The detail surface has the full
 * system_prompt, but the index only ever sees list items, so kind derives
 * from the field both surfaces carry.
 */
export function deriveAgentKind(agent: { description?: string | null }): string {
	const role = agent.description?.split('\n')[0]?.trim()
	return role || 'Agent'
}
