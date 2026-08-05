import type { QueryClient } from '@tanstack/react-query'
import { trackAgentSessionCompleted, trackTriggerFired } from './analytics'
import { queryKeys } from './query-keys'
import type { SSEEvent } from './sse'

const SESSION_COMPLETION_ACTIONS = new Map<string, 'completed' | 'failed' | 'timeout'>([
	['session_completed', 'completed'],
	['session_failed', 'failed'],
	['session_timeout', 'timeout'],
])

export function invalidateFromSSE(queryClient: QueryClient, workspaceId: string, event: SSEEvent) {
	// Always invalidate events history
	queryClient.invalidateQueries({ queryKey: queryKeys.events.history(workspaceId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(event.entity_id) })

	// Live-refresh the knowledge doc-header reference-count chip. The DoD
	// tolerates a 5-minute lag (matches the hook's staleTime), but when a
	// fresh cite lands over SSE we already know a downstream agent read this
	// object — invalidate the counter so the chip catches up in the same tick.
	if (event.action === 'workspace_knowledge_referenced') {
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.references(event.entity_id) })
	}

	// New comments may change unread counts for any subscriber in this workspace
	// and the subscriber list for the entity that was commented on (the latter
	// because the commenter auto-subscribes server-side).
	if (event.action === 'commented') {
		queryClient.invalidateQueries({
			queryKey: ['subscriptions', 'unread', workspaceId],
		})
		queryClient.invalidateQueries({
			queryKey: queryKeys.subscriptions.subscribers(event.entity_type, event.entity_id),
		})
		// Also refresh the detail/graph so unread_count + subscriber_count update.
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(event.entity_id) })
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(event.entity_id) })
	}

	// Invalidate based on entity type
	switch (event.entity_type) {
		case 'insight':
		case 'bet':
		case 'task':
		case 'commitment':
		case 'loop':
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
			if (event.action === 'trigger_fired') {
				trackTriggerFired({
					entity_id: event.entity_id,
					entity_type: 'trigger',
					flow_id: event.event_id ?? null,
				})
			}
			break
		case 'session': {
			// Broad prefix invalidation covers all session queries including byActor
			queryClient.invalidateQueries({ queryKey: ['sessions'] })
			const outcome = SESSION_COMPLETION_ACTIONS.get(event.action)
			if (outcome) {
				trackAgentSessionCompleted({
					entity_id: event.entity_id,
					entity_type: 'session',
					outcome,
					flow_id: event.event_id ?? null,
				})
			}
			break
		}
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
		case 'file':
			// all() is a prefix of detail() so this covers both list and detail queries.
			queryClient.invalidateQueries({ queryKey: queryKeys.files.all(workspaceId) })
			break
	}
}
