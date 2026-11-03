import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

/** The agent-facing briefing markdown — what `/$workspaceId/briefing` renders. */
export function useBriefing(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.briefing.current(workspaceId),
		queryFn: () => api.briefing.get(workspaceId),
		enabled: !!workspaceId,
	})
}

/**
 * Today's brief as spoken prose, fetched only when asked for.
 *
 * `enabled: false` is the whole point: generating the brief costs a model
 * call, so nothing happens until the card calls `refetch()` — pressing play.
 * Once fetched it stays in the query cache for the session (`staleTime:
 * Infinity`), so re-opening the card or navigating back doesn't ask again.
 * The server keeps its own per-day cache behind this, so even a cold client
 * that refetches usually costs nothing.
 */
export function useSpokenBrief(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.briefing.spoken(workspaceId),
		queryFn: () => api.briefing.spoken(workspaceId),
		enabled: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
	})
}
