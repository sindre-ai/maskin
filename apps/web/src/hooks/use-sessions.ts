import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useSessions(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.all(workspaceId),
		queryFn: () => api.sessions.list(workspaceId),
		enabled: !!workspaceId,
	})
}
