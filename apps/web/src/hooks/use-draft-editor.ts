import type { ChatCardRef, ObjectResponse } from '@/lib/api'
import {
	type DraftRef,
	approveDraftText,
	getDraftChange,
	getDraftEdit,
	subscribeDraftEdits,
} from '@/lib/draft-edits'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

/** The text a person has typed into a draft and not yet approved, or undefined when they have changed nothing. */
export function useDraftEdit(objectId: string): string | undefined {
	return useSyncExternalStore(
		subscribeDraftEdits,
		() => getDraftEdit(objectId),
		() => undefined,
	)
}

/** The text a draft turned out to have when it changed under the person, or undefined. */
export function useDraftChange(objectId: string): string | undefined {
	return useSyncExternalStore(
		subscribeDraftEdits,
		() => getDraftChange(objectId),
		() => undefined,
	)
}

/**
 * Approve a draft from a card that can edit it: saves the person's edit, then approves the
 * saved text (see `approveDraftText`). Settles the cache like `useApproveObject`, so the card
 * reads Approved at once. The For You card calls `approveDraftText` directly, inside its
 * send step; this is the same step as a button with a pending and an error state.
 */
export function useApproveDraft() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ draft, chat }: { draft: DraftRef; chat?: ChatCardRef }) =>
			approveDraftText(draft, chat),
		onSuccess: (data, { draft }) => {
			if (!data || !draft.object_id) return
			queryClient.setQueryData<ObjectResponse>(
				queryKeys.objects.detail(draft.object_id),
				(cached) => (cached ? { ...cached, preview: data.preview } : cached),
			)
		},
		onSettled: (_data, _error, { draft }) => {
			if (!draft.object_id) return
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(draft.object_id) })
		},
	})
}
