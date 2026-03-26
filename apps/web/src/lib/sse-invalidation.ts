import { getAllWebModules } from '@ai-native/module-sdk'
import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import type { SSEEvent } from './sse'

/** Get all object type strings from registered modules */
function getModuleObjectTypes(): Set<string> {
	const types = new Set<string>()
	for (const mod of getAllWebModules()) {
		for (const tab of mod.objectTypeTabs) {
			types.add(tab.value)
		}
	}
	return types
}

export function invalidateFromSSE(queryClient: QueryClient, workspaceId: string, event: SSEEvent) {
	// Always invalidate events history
	queryClient.invalidateQueries({ queryKey: queryKeys.events.history(workspaceId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(event.entity_id) })

	// Check if the entity type is a module object type
	const objectTypes = getModuleObjectTypes()
	if (objectTypes.has(event.entity_type)) {
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(event.entity_id) })
		// Legacy: bets query key is still used in use-objects.ts and use-bets.ts
		if (event.entity_type === 'bet') {
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		}
		return
	}

	// Invalidate based on core entity types
	switch (event.entity_type) {
		case 'relationship':
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
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
