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
		case 'knowledge':
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(event.entity_id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(event.entity_id) })
			if (event.entity_type === 'bet') {
				queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			}
			break
		case 'relationship':
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: ['objects', 'graph'] })
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
		case 'workspace_skill':
			// all() is a prefix of detail() so this covers both list and detail queries
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			break
		case 'agent_skill':
			// The event's entity_id is the workspace-skill id; the target actorId is not in the
			// SSE payload, so invalidate all attachment queries in this tab with a broad prefix.
			queryClient.invalidateQueries({ queryKey: ['agent-skill-attachments'] })
			break
	}
}
