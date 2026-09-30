import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The observability spec keys the round-send event and the comment-posted
// `source=file_viewer` off the analytics helpers — mock those so we can
// assert what fires without a running PostHog client. `sonner` too, since
// the send mutation calls `toast.success` on success.
vi.mock('@/lib/analytics', () => ({
	trackCommentPosted: vi.fn(),
	trackFileViewerCommentResolved: vi.fn(),
	trackFileViewerRoundSent: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}))

vi.mock('@/lib/api', () => ({
	api: {
		fileComments: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			sendRound: vi.fn(),
		},
	},
}))

import {
	useCreateFileComment,
	useFileComments,
	useSendFileCommentsRound,
	useUpdateFileComment,
} from '@/hooks/use-file-comments'
import {
	trackCommentPosted,
	trackFileViewerCommentResolved,
	trackFileViewerRoundSent,
} from '@/lib/analytics'
import { type FileCommentDto, type SendRoundResponse, api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const fileId = 'file-1'
const targetObjectId = '11111111-1111-1111-1111-111111111111'
const roundId = '22222222-2222-2222-2222-222222222222'

const draftRow: FileCommentDto = {
	id: 'c1',
	fileId,
	page: 0,
	positionDoc: { x: 0.5, y: 0.5 },
	selector: null,
	authorId: 'actor-1',
	body: 'looks off',
	parentId: null,
	roundId: null,
	resolvedAt: null,
	resolvedBy: null,
	createdAt: '2026-09-27T09:00:00.000Z',
	updatedAt: '2026-09-27T09:00:00.000Z',
}

const sentRow: FileCommentDto = { ...draftRow, roundId }

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useFileComments — reads unified list, incl. legacy-migrated pins', () => {
	// AC: "Legacy file.annotations pins for a file with legacy data show as
	// unified file_comments in the panel on first open (backed by backend
	// task's server-side migration)." The FE hook only calls the endpoint —
	// the backend migration is what returns the merged list — so the check
	// here is: the hook returns whatever the server sent, with no client-side
	// splitting. A legacy pin shows up as a comment row like any other.
	it('renders legacy-migrated pins through the same list as fresh comments', async () => {
		const legacy: FileCommentDto = { ...draftRow, id: 'legacy-1', selector: 'legacy' }
		vi.mocked(api.fileComments.list).mockResolvedValue([legacy, draftRow])

		const { result } = renderHook(() => useFileComments(workspaceId, fileId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([legacy, draftRow])
	})
})

describe('useCreateFileComment — comment_posted fires with source: file_viewer', () => {
	// AC: "Emitted PostHog events include comment_posted with source: file_viewer".
	it('fires the analytics helper with source=file_viewer on success', async () => {
		vi.mocked(api.fileComments.create).mockResolvedValue(draftRow)
		const { result } = renderHook(() => useCreateFileComment(workspaceId, fileId), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.mutateAsync({
				body: 'looks off',
				page: 0,
				positionDoc: { x: 0.5, y: 0.5 },
			})
		})
		expect(trackCommentPosted).toHaveBeenCalledWith(
			expect.objectContaining({
				entity_id: fileId,
				entity_type: 'file',
				source: 'file_viewer',
				is_reply: false,
			}),
		)
	})
})

describe('useUpdateFileComment — resolve fires comment_resolved', () => {
	it('emits file_viewer_comment_resolved when resolved=true', async () => {
		const resolved: FileCommentDto = {
			...draftRow,
			resolvedAt: '2026-09-27T10:00:00.000Z',
			resolvedBy: 'actor-1',
		}
		vi.mocked(api.fileComments.update).mockResolvedValue(resolved)
		const { result } = renderHook(() => useUpdateFileComment(workspaceId, fileId), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.mutateAsync({ commentId: draftRow.id, data: { resolved: true } })
		})
		expect(trackFileViewerCommentResolved).toHaveBeenCalledWith({
			file_id: fileId,
			comment_id: resolved.id,
			resolved_by: 'actor-1',
		})
	})

	it('does not emit resolved event when only body changes', async () => {
		vi.mocked(api.fileComments.update).mockResolvedValue({ ...draftRow, body: 'updated' })
		const { result } = renderHook(() => useUpdateFileComment(workspaceId, fileId), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.mutateAsync({
				commentId: draftRow.id,
				data: { body: 'updated' },
			})
		})
		expect(trackFileViewerCommentResolved).not.toHaveBeenCalled()
	})
})

describe('useSendFileCommentsRound — batched POST + rollup event', () => {
	// AC: "Send round emits exactly one POST /files/:id/comments/rounds carrying
	// a client-generated roundId".
	it('POSTs exactly once with the supplied roundId + targetObjectId + commentIds', async () => {
		const resp: SendRoundResponse = {
			roundId,
			count: 2,
			rollupEventId: 42,
			comments: [sentRow, { ...sentRow, id: 'c2' }],
		}
		vi.mocked(api.fileComments.sendRound).mockResolvedValue(resp)

		const { result } = renderHook(() => useSendFileCommentsRound(workspaceId, fileId), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.mutateAsync({
				roundId,
				targetObjectId,
				commentIds: ['c1', 'c2'],
				driverId: 'driver-1',
			})
		})
		expect(api.fileComments.sendRound).toHaveBeenCalledTimes(1)
		// driverId is analytics-only and must not reach the request body.
		expect(api.fileComments.sendRound).toHaveBeenCalledWith(workspaceId, fileId, {
			roundId,
			targetObjectId,
			commentIds: ['c1', 'c2'],
		})
		expect(trackFileViewerRoundSent).toHaveBeenCalledWith(
			expect.objectContaining({
				file_id: fileId,
				comment_count: 2,
				attaching_object_id: targetObjectId,
				driver_id: 'driver-1',
				round_id: roundId,
			}),
		)
	})

	it('does not fire any additional POST or notification when the server confirms', async () => {
		// Server writes 1 rollup event → 1 For You card. AC: "For You card shows
		// one, not N". This is asserted via the mock: only ONE call to sendRound.
		vi.mocked(api.fileComments.sendRound).mockResolvedValue({
			roundId,
			count: 5,
			rollupEventId: 43,
			comments: [],
		})
		const { result } = renderHook(() => useSendFileCommentsRound(workspaceId, fileId), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.mutateAsync({
				roundId,
				targetObjectId,
				commentIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
			})
		})
		expect(api.fileComments.sendRound).toHaveBeenCalledTimes(1)
	})
})
