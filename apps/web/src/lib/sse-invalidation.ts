import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import type { SSEEvent } from './sse'

export function invalidateFromSSE(queryClient: QueryClient, workspaceId: string, event: SSEEvent) {
	// Always invalidate events history
	queryClient.invalidateQueries({ queryKey: queryKeys.events.history(workspaceId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(event.entity_id) })

	// Invalidate based on entity type
	switch (event.entity_type) {
		case 'insight':
		case 'bet':
		case 'task':
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(event.entity_id) })
			if (event.entity_type === 'bet') {
				queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			}
			break
		case 'relationship':
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			break
		case 'trigger':
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			break
		case 'session':
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(event.entity_id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.logs(event.entity_id) })
			break
		case 'notification':
			queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all(workspaceId) })
			break
		case 'actor':
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			break
		case 'workspace':
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all() })
			break
	}
}
