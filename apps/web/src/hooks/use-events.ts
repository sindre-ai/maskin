import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useEvents(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.events.history(workspaceId, filters),
		queryFn: () => api.events.history(workspaceId, filters),
	})
}

export function useEntityEvents(workspaceId: string, entityId: string) {
	return useQuery({
		queryKey: queryKeys.events.byEntity(entityId),
		queryFn: () => api.events.history(workspaceId, { entity_id: entityId, limit: '20' }),
		enabled: !!entityId,
	})
}
