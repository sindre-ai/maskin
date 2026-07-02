import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { trackCommentPosted } from '../lib/analytics'
import { type CreateCommentInput, type EventResponse, type ObjectResponse, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useEvents(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.events.history(workspaceId, filters),
		queryFn: () => api.events.history(workspaceId, filters),
	})
}

export function useEntityEvents(
	workspaceId: string,
	entityId: string,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: queryKeys.events.byEntity(entityId),
		queryFn: () => api.events.history(workspaceId, { entity_id: entityId, limit: '50' }),
		enabled: enabled && !!entityId,
	})
}

// Shared across both comment-posting paths: the simple hook below, and the
// attachment-aware queue in `pending-comments-context.tsx`. Keeping the
// taxonomy contract in one place stops the two paths from drifting.
export function trackCommentPostedFor(
	queryClient: ReturnType<typeof useQueryClient>,
	entityId: string,
	data: CreateCommentInput,
	flowId: string | null,
): void {
	const cached = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(entityId))
	const type = cached?.type
	if (type !== 'bet' && type !== 'task' && type !== 'insight' && type !== 'knowledge') return
	trackCommentPosted({
		entity_id: entityId,
		entity_type: type,
		is_reply: data.parent_event_id !== undefined,
		attachment_count: data.attachment_file_ids?.length ?? 0,
		// Carried so the bet's `properties.content CONTAINS '\n'` PostHog query
		// can count multi-line mobile comments. Both submit paths feed through
		// here so the contract stays in one place.
		content: data.content,
		flow_id: flowId,
	})
}

export function useCreateComment(workspaceId: string, entityId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateCommentInput) => api.events.create(workspaceId, data),
		onSuccess: (_result, variables) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(entityId) })
			trackCommentPostedFor(queryClient, entityId, variables, null)
		},
	})
}

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight'])
const OBJECT_ACTIONS = new Set(['created', 'updated', 'status_changed'])

export interface AffectedObject {
	entityId: string
	entityType: string
	title: string | null
	actions: string[]
}

function deriveAffectedObjects(events: EventResponse[]): AffectedObject[] {
	const map = new Map<string, AffectedObject>()

	for (const event of events) {
		if (!OBJECT_ENTITY_TYPES.has(event.entityType)) continue
		if (!OBJECT_ACTIONS.has(event.action)) continue

		const existing = map.get(event.entityId)
		if (existing) {
			if (!existing.actions.includes(event.action)) {
				existing.actions.push(event.action)
			}
			// Prefer a title from data if we don't have one yet
			if (!existing.title && event.data) {
				existing.title = (event.data as Record<string, unknown>).title as string | null
			}
		} else {
			map.set(event.entityId, {
				entityId: event.entityId,
				entityType: event.entityType,
				title: event.data
					? (((event.data as Record<string, unknown>).title as string | null) ?? null)
					: null,
				actions: [event.action],
			})
		}
	}

	return Array.from(map.values())
}

export function useSessionAffectedObjects(
	startedAt: string | null,
	completedAt: string | null,
	workspaceId: string,
	enabled = true,
) {
	const filters = startedAt
		? {
				after: startedAt,
				...(completedAt ? { before: completedAt } : {}),
				limit: '100',
			}
		: undefined

	const query = useQuery({
		queryKey: ['sessions', 'affected-objects', startedAt, completedAt],
		queryFn: () => api.events.history(workspaceId, filters),
		enabled: enabled && !!startedAt,
	})

	const affectedObjects = query.data ? deriveAffectedObjects(query.data) : []

	return {
		...query,
		affectedObjects,
	}
}
