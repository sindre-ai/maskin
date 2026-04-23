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
			// Participation edges (`assigned_to`, `watches`) are derived into the objects
			// response as `assignees[]` + `watchers[]`. We can't tell from the NOTIFY payload
			// which object was the source, so invalidate the workspace-wide object caches.
			// Object-to-object edges (`informs`, `breaks_into`, …) benefit too: LinkedObjects
			// counts update without a reload.
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			break
		case 'trigger':
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			break
		case 'session':
			// Broad prefix invalidation covers all session queries including byActor
			queryClient.invalidateQueries({ queryKey: ['sessions'] })
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
