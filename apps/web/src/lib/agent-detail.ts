import type { SessionResponse } from '@/lib/api'

/** The tabs of the agent page, in the order they are drawn. */
export const AGENT_TABS = ['setup', 'triggers', 'items', 'sessions', 'computer'] as const
export type AgentTab = (typeof AGENT_TABS)[number]

/** The tab the page opens on; an unknown or retired `?tab=` (the old `overview`) lands here. */
export const DEFAULT_AGENT_TAB: AgentTab = 'setup'

/** Reads the `tab` search param: anything that is not a known tab is left for the default. */
export function parseAgentTab(value: unknown): AgentTab | undefined {
	return typeof value === 'string' && (AGENT_TABS as readonly string[]).includes(value)
		? (value as AgentTab)
		: undefined
}

const LIVE_STATUSES = new Set(['running', 'starting', 'pending'])
const FAILED_STATUSES = new Set(['failed', 'timeout'])

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
