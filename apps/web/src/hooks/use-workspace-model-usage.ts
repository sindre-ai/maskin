import { useActors } from '@/hooks/use-actors'
import { pickBucket } from '@/hooks/use-session-usage'
import { type SessionUsageResponse, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

export interface WorkspaceUsageRow {
	id: string
	name: string
	type: string
	costUsd: number
	sessions: number
	tokens: number
}

export interface WorkspaceModelUsage {
	isLoading: boolean
	/** True once at least one agent reported a completed session this month. */
	hasUsage: boolean
	totalCostUsd: number
	totalSessions: number
	rows: WorkspaceUsageRow[]
	periodStart: Date
	resetsAt: Date
}

/** First instant of the current calendar month, and the first of the next. */
function monthWindow(now: Date): { from: Date; to: Date; resetsAt: Date } {
	const from = new Date(now.getFullYear(), now.getMonth(), 1)
	const resetsAt = new Date(now.getFullYear(), now.getMonth() + 1, 1)
	// `to` must be strictly after `from` — the API rejects an empty range, which
	// is reachable at exactly midnight on the 1st.
	const to = new Date(Math.max(now.getTime(), from.getTime() + 1000))
	return { from, to, resetsAt }
}

function totalTokens(totals: SessionUsageResponse['totals'] | undefined): number {
	if (!totals) return 0
	return totals.input_tokens + totals.output_tokens + totals.cache_tokens
}

/**
 * Aggregates this calendar month's session cost across the workspace's agents.
 *
 * Uses `useQueries` (not `useSessionUsage`) because the agent count is only
 * known at runtime — the query key and fetcher are the same ones the hook uses,
 * so both surfaces share one cache entry per agent.
 */
export function useWorkspaceModelUsage(workspaceId: string): WorkspaceModelUsage {
	const { data: actors, isLoading: actorsLoading } = useActors(workspaceId)
	const agents = useMemo(() => (actors ?? []).filter((a) => a.type === 'agent'), [actors])

	// One window for the whole render pass, so every agent query shares a key.
	const period = useMemo(() => monthWindow(new Date()), [])
	const fromISO = period.from.toISOString()
	const toISO = period.to.toISOString()
	const bucket = pickBucket(period.from.getTime(), period.to.getTime())

	const results = useQueries({
		queries: agents.map((agent) => ({
			queryKey: queryKeys.sessions.usage(workspaceId, agent.id, {
				from: fromISO,
				to: toISO,
				bucket,
			}),
			queryFn: () =>
				api.sessions.usage(workspaceId, {
					actor_id: agent.id,
					from: fromISO,
					to: toISO,
					bucket,
				}),
			enabled: Boolean(workspaceId),
			staleTime: 30_000,
		})),
	})

	const isLoading = actorsLoading || results.some((r) => r.isLoading)

	const rows = agents
		.map((agent, index) => ({
			id: agent.id,
			name: agent.name,
			type: agent.type,
			costUsd: results[index]?.data?.totals.total_cost_usd ?? 0,
			sessions: results[index]?.data?.totals.session_count ?? 0,
			tokens: totalTokens(results[index]?.data?.totals),
		}))
		.filter((row) => row.sessions > 0)
		.sort((a, b) => b.costUsd - a.costUsd)

	const totalCostUsd = rows.reduce((sum, row) => sum + row.costUsd, 0)
	const totalSessions = rows.reduce((sum, row) => sum + row.sessions, 0)

	return {
		isLoading,
		hasUsage: rows.length > 0,
		totalCostUsd,
		totalSessions,
		rows,
		periodStart: period.from,
		resetsAt: period.resetsAt,
	}
}
