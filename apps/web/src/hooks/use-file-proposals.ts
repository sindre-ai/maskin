import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

// Open change proposals an agent made on a markdown file. Read-only for any
// member; deciding a change needs a non-viewer human, which the server checks.
export function useFileProposals(workspaceId: string, fileId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.fileProposals.open(workspaceId, fileId),
		queryFn: () => api.fileProposals.listOpen(workspaceId, fileId),
		select: (data) => data.proposals,
		enabled: enabled && !!workspaceId && !!fileId,
	})
}

/**
 * Refetches the open proposals and the file. The review view calls this once a
 * decided card has finished fading, so the refetch cannot drop the card mid-fade.
 */
export function useRefreshFileReview(workspaceId: string, fileId: string) {
	const queryClient = useQueryClient()
	return useCallback(
		() =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: queryKeys.fileProposals.open(workspaceId, fileId),
				}),
				// An accept rewrites the file, so the text the review is laid out from changed.
				queryClient.invalidateQueries({ queryKey: queryKeys.files.detail(workspaceId, fileId) }),
			]),
		[queryClient, workspaceId, fileId],
	)
}

interface DecideInput {
	proposalId: string
	changeId: string
	/** Accept only: the human's edited text. Left out when the proposed text is applied as is. */
	appliedText?: string
}

function useDecide<T>(call: (input: T) => Promise<unknown>, failure: string | null) {
	return useMutation({
		mutationFn: call,
		// Failures are shown on the card, in the stale note or by the toast below, never as the raw API message.
		meta: { handlesOwnErrors: true },
		onError: () => {
			if (failure) toast.error(failure)
		},
	})
}

// A failed accept is shown on its card (Retry), so it raises no toast.
export function useAcceptChange(workspaceId: string, fileId: string) {
	return useDecide(
		({ proposalId, changeId, appliedText }: DecideInput) =>
			api.fileProposals.accept(workspaceId, fileId, proposalId, changeId, appliedText),
		null,
	)
}

export function useRejectChange(workspaceId: string, fileId: string) {
	return useDecide(
		({ proposalId, changeId }: DecideInput) =>
			api.fileProposals.reject(workspaceId, fileId, proposalId, changeId),
		"Couldn't reject this change. Try again.",
	)
}

interface DecideAllInput {
	proposalId: string
	changeIds: string[]
}

// Accept all: a refusal for stale changes is handled by the review view (the stale
// cards are marked), so only other failures raise a toast, from the view.
export function useAcceptAll(workspaceId: string, fileId: string) {
	return useDecide(
		({ proposalId, changeIds }: DecideAllInput) =>
			api.fileProposals.acceptAll(workspaceId, fileId, proposalId, changeIds),
		null,
	)
}

export function useRejectAll(workspaceId: string, fileId: string) {
	return useDecide(
		({ proposalId, changeIds }: DecideAllInput) =>
			api.fileProposals.rejectAll(workspaceId, fileId, proposalId, changeIds),
		"Couldn't reject these changes. Try again.",
	)
}
