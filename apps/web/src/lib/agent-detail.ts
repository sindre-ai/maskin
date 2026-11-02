import type { SessionResponse } from '@/lib/api'

/** The tabs of the agent page, in the order they are drawn. */
export const AGENT_TABS = ['overview', 'sessions', 'setup', 'triggers', 'computer'] as const
export type AgentTab = (typeof AGENT_TABS)[number]

/** Reads the `tab` search param: anything that is not a known tab is the Overview. */
export function parseAgentTab(value: unknown): AgentTab | undefined {
	return typeof value === 'string' && (AGENT_TABS as readonly string[]).includes(value)
		? (value as AgentTab)
		: undefined
}

const LIVE_STATUSES = new Set(['running', 'starting', 'pending'])
const FAILED_STATUSES = new Set(['failed', 'timeout'])
const FINISHED_STATUSES = new Set(['completed', 'failed', 'timeout', 'user_stopped'])

type SessionLike = Pick<SessionResponse, 'id' | 'status' | 'createdAt'>

const byNewest = (a: SessionLike, b: SessionLike) =>
	new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()

export type AgentFocus<T extends SessionLike> =
	| { kind: 'working'; session: T }
	| { kind: 'failed'; session: T }
	| null

/**
 * What the top of the page should call attention to. A run that is live wins (the
 * Working-now card); otherwise the newest run decides: if it failed, the page says so
 * with Retry and See log. An older failure behind a newer success is history, not news.
 */
export function deriveAgentFocus<T extends SessionLike>(sessions: T[]): AgentFocus<T> {
	const newestFirst = [...sessions].sort(byNewest)
	const live = newestFirst.find((s) => LIVE_STATUSES.has(s.status))
	if (live) return { kind: 'working', session: live }
	const latest = newestFirst[0]
	if (latest && FAILED_STATUSES.has(latest.status)) return { kind: 'failed', session: latest }
	return null
}

export interface AgentStats {
	/** Runs the page knows about. */
	sessions: number
	/** Runs that ended, and how many of those ended well. Null until one has ended. */
	finished: { total: number; completed: number } | null
}

export function deriveAgentStats(sessions: SessionLike[]): AgentStats {
	const finished = sessions.filter((s) => FINISHED_STATUSES.has(s.status))
	return {
		sessions: sessions.length,
		finished:
			finished.length > 0
				? {
						total: finished.length,
						completed: finished.filter((s) => s.status === 'completed').length,
					}
				: null,
	}
}
