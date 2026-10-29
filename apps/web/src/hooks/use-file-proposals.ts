import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

interface DecideInput {
	proposalId: string
	changeId: string
	/** Accept only: the human's edited text. Left out when the proposed text is applied as is. */
	appliedText?: string
}

function useDecide(
	workspaceId: string,
	fileId: string,
	call: (input: DecideInput) => Promise<unknown>,
	failure: string,
) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: call,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.fileProposals.open(workspaceId, fileId) })
			// An accept rewrites the file, so the text the review is laid out from changed.
			queryClient.invalidateQueries({ queryKey: queryKeys.files.detail(workspaceId, fileId) })
		},
		onError: () => toast.error(failure),
	})
}

export function useAcceptChange(workspaceId: string, fileId: string) {
	return useDecide(
		workspaceId,
		fileId,
		({ proposalId, changeId, appliedText }) =>
			api.fileProposals.accept(workspaceId, fileId, proposalId, changeId, appliedText),
		"Couldn't apply this change. Try again.",
	)
}

export function useRejectChange(workspaceId: string, fileId: string) {
	return useDecide(
		workspaceId,
		fileId,
		({ proposalId, changeId }) =>
			api.fileProposals.reject(workspaceId, fileId, proposalId, changeId),
		"Couldn't reject this change. Try again.",
	)
}
