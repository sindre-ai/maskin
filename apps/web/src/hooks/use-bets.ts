import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useBets(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.bets.all(workspaceId),
		queryFn: () => api.objects.list(workspaceId, { type: 'bet' }),
	})
}
