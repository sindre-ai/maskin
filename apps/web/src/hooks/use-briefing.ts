import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

// Powers the featured briefing card at the top of the For You feed. The route
// marks the response `Cache-Control: private` (per-user unreadDelta) — SSE
// invalidation from `lib/sse-invalidation.ts` on a new briefing knowledge
// object refreshes this query without a page reload.
export function useBriefing(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.briefing.latest(workspaceId),
		queryFn: () => api.briefing.latest(workspaceId),
		enabled: !!workspaceId,
	})
}
