import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
	trackCommentPosted,
	trackFileViewerCommentResolved,
	trackFileViewerRoundSent,
} from '../lib/analytics'
import {
	ApiError,
	type CreateFileCommentInput,
	type FileCommentDto,
	type SendRoundInput,
	type UpdateFileCommentInput,
	api,
} from '../lib/api'
import { queryKeys } from '../lib/query-keys'

// Live server rows for a file. Legacy `file.annotations` are ported into
// `file_comments` on first read (backend task's migration), so callers of this
// hook receive one unified list regardless of pin origin — that satisfies the
// Slice 3 "legacy display" acceptance criterion.
export function useFileComments(
	workspaceId: string,
	fileId: string | null,
	params?: { roundId?: string },
) {
	return useQuery({
		queryKey: [
			...queryKeys.fileComments.all(workspaceId, fileId ?? ''),
			params?.roundId ?? null,
		] as const,
		queryFn: () => {
			if (!fileId) return Promise.resolve<FileCommentDto[]>([])
			return api.fileComments.list(workspaceId, fileId, params)
		},
		enabled: !!workspaceId && !!fileId,
	})
}

export function useCreateFileComment(workspaceId: string, fileId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: CreateFileCommentInput) =>
			api.fileComments.create(workspaceId, fileId, input),
		onSuccess: (created) => {
			// The comment landed on the file. Attribute the post to `file_viewer`
			// so the "≥ 40% comment-after-view within 24h" success criterion is
			// measurable on PostHog (spec §Observability).
			trackCommentPosted({
				entity_id: fileId,
				entity_type: 'file',
				source: 'file_viewer',
				is_reply: created.parentId !== null,
				attachment_count: 0,
				content: created.body,
			})
			queryClient.invalidateQueries({
				queryKey: queryKeys.fileComments.all(workspaceId, fileId),
			})
		},
	})
}

export function useUpdateFileComment(workspaceId: string, fileId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			commentId,
			data,
		}: {
			commentId: string
			data: UpdateFileCommentInput
		}) => api.fileComments.update(workspaceId, fileId, commentId, data),
		onSuccess: (updated, variables) => {
			if (variables.data.resolved === true) {
				trackFileViewerCommentResolved({
					file_id: fileId,
					comment_id: updated.id,
					resolved_by: updated.resolvedBy ?? '',
				})
			}
			queryClient.invalidateQueries({
				queryKey: queryKeys.fileComments.all(workspaceId, fileId),
			})
		},
	})
}

// Plain-language message for each way sending a round can fail. Anything else
// (network down, server error) gets the generic line.
function sendRoundErrorMessage(err: unknown): string {
	if (!(err instanceof ApiError)) return "Couldn't send your comments. Please try again."
	switch (err.code) {
		case 'RATE_LIMITED': {
			const seconds = Math.max(1, Math.ceil((err.retryAfterMs ?? 0) / 1000))
			return `You're sending too quickly. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
		}
		case 'NO_ATTACHER':
			return "This file isn't linked to anything yet, so there's nowhere to send it."
		case 'WRONG_TARGET':
			return "That item isn't linked to this file. Pick another one."
		case 'TARGET_ARCHIVED':
			return 'That item was archived. Pick another one to send to.'
		case 'STALE_COMMENTS':
			return 'Some comments have changed. Reload the page and try again.'
		default:
			return "Couldn't send your comments. Please try again."
	}
}

export function useSendFileCommentsRound(workspaceId: string, fileId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: { handlesOwnErrors: true },
		// driverId is analytics-only (the server resolves the driver itself), so it
		// is stripped before the request body is built.
		mutationFn: ({
			driverId: _driverId,
			...input
		}: SendRoundInput & { driverId?: string | null }) =>
			api.fileComments.sendRound(workspaceId, fileId, input),
		onSuccess: (result, variables) => {
			trackFileViewerRoundSent({
				file_id: fileId,
				comment_count: result.count,
				attaching_object_id: variables.targetObjectId,
				driver_id: variables.driverId ?? '',
				round_id: result.roundId,
			})
			// Server rewrote every row's roundId in one transaction; refetch the
			// canonical list so the panel's "Sent · driver-name" lock renders
			// against server truth, not client-optimistic state.
			queryClient.invalidateQueries({
				queryKey: queryKeys.fileComments.all(workspaceId, fileId),
			})
			// The rollup event lands on the attaching object's timeline. Nudge
			// consumers to re-read that object's events so the driver's For You
			// card and event list update without a page reload.
			queryClient.invalidateQueries({
				queryKey: queryKeys.events.byEntity(variables.targetObjectId),
			})
			toast.success(`Round sent — ${result.count} comment${result.count === 1 ? '' : 's'}`)
		},
		onError: (err: unknown) => {
			toast.error(sendRoundErrorMessage(err))
		},
	})
}
