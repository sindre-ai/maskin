import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import type { SSEEvent } from './sse'

// Non-object entity types that have dedicated query keys
const NON_OBJECT_ENTITY_TYPES = new Set([
	'relationship',
	'trigger',
	'notification',
	'actor',
	'workspace',
	'session',
	'integration',
])

export function invalidateFromSSE(queryClient: QueryClient, workspaceId: string, event: SSEEvent) {
	// Always invalidate events history
	queryClient.invalidateQueries({ queryKey: queryKeys.events.history(workspaceId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(event.entity_id) })

	// Invalidate based on entity type
	switch (event.entity_type) {
		case 'relationship':
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			break
		case 'trigger':
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
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
		default:
			// Any entity type not in the known non-object set is treated as an object type
			if (!NON_OBJECT_ENTITY_TYPES.has(event.entity_type)) {
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(event.entity_id) })
				// Also invalidate bets for backwards compat
				if (event.entity_type === 'bet') {
					queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
				}
			}
			break
	}
}
