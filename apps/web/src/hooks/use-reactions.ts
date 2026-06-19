import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactionsByObjectResponse, api } from '../lib/api'
import { getStoredActor } from '../lib/auth'
import { queryKeys } from '../lib/query-keys'

/**
 * Fetches reactions for every event under a given object in one round-trip,
 * returned as a Record keyed by stringified event id. The activity feed calls
 * this once per object and each `ActivityComment` looks up its own row.
 */
export function useReactionsByObject(
	workspaceId: string,
	objectId: string,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: queryKeys.reactions.byObject(objectId),
		queryFn: () => api.reactions.listByObject(workspaceId, objectId),
		enabled: enabled && !!objectId,
	})
}

/**
 * Toggle a reaction on an event. Optimistically rewrites the cached reaction
 * map so the chip flips instantly, then either keeps the optimistic state on
 * success or rolls back on error. Server-side state arrives via SSE
 * (`reacted` / `unreacted` actions) which invalidates this same query key.
 */
type ToggleVars = { eventId: number; emoji: string; op: 'add' | 'remove' }
type ToggleContext = { previous: ReactionsByObjectResponse | undefined }

export function useToggleReaction(workspaceId: string, objectId: string) {
	const queryClient = useQueryClient()
	const currentActorId = getStoredActor()?.id ?? null

	return useMutation<{ ok: true }, Error, ToggleVars, ToggleContext>({
		mutationFn: async ({ eventId, emoji, op }) => {
			if (op === 'add') {
				await api.reactions.add(workspaceId, eventId, emoji)
			} else {
				await api.reactions.remove(workspaceId, eventId, emoji)
			}
			return { ok: true }
		},
		onMutate: async ({ eventId, emoji, op }) => {
			const key = queryKeys.reactions.byObject(objectId)
			await queryClient.cancelQueries({ queryKey: key })
			const previous = queryClient.getQueryData<ReactionsByObjectResponse>(key)
			if (!currentActorId) return { previous }

			queryClient.setQueryData<ReactionsByObjectResponse>(key, (old) => {
				const map = { ...(old?.reactionsByEventId ?? {}) }
				const slot = String(eventId)
				const list = map[slot] ? [...map[slot]] : []
				if (op === 'add') {
					if (!list.some((r) => r.actorId === currentActorId && r.emoji === emoji)) {
						list.push({
							// Synthetic id — replaced when the server response is invalidated in.
							id: `optimistic-${currentActorId}-${eventId}-${emoji}`,
							eventId,
							actorId: currentActorId,
							emoji,
							createdAt: new Date().toISOString(),
						})
					}
				} else {
					const idx = list.findIndex((r) => r.actorId === currentActorId && r.emoji === emoji)
					if (idx !== -1) list.splice(idx, 1)
				}
				map[slot] = list
				return { reactionsByEventId: map }
			})

			return { previous }
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.previous) {
				queryClient.setQueryData(queryKeys.reactions.byObject(objectId), ctx.previous)
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reactions.byObject(objectId) })
		},
	})
}
