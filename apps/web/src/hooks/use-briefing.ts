import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

export function useBriefing(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.briefing.current(workspaceId),
		queryFn: () => api.briefing.get(workspaceId),
		enabled: !!workspaceId,
	})
}
