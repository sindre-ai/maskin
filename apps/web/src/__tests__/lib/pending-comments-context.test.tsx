import {
	PendingCommentsProvider,
	useDraft,
	usePendingCommentsForObject,
} from '@/lib/pending-comments-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const uploadProgressMock = vi.fn()
const eventsCreateMock = vi.fn()

vi.mock('@/lib/api', async () => {
	return {
		api: {
			files: {
				createWithProgress: (
					_workspaceId: string,
					body: { name: string },
					opts?: { onProgress?: (p: number) => void; signal?: AbortSignal },
				) =>
					uploadProgressMock(body, opts).then((file: { id: string }) => ({
						id: file.id,
						workspaceId: 'ws-1',
						name: body.name,
						description: null,
						mimeType: 'text/plain',
						sizeBytes: 4,
						storageKey: 'k',
						createdBy: 'actor-1',
						createdAt: '2026-05-21T00:00:00Z',
						updatedAt: '2026-05-21T00:00:00Z',
						content: '',
						url: 'http://localhost/file',
					})),
			},
			events: {
				create: (_ws: string, body: unknown) => eventsCreateMock(body),
			},
		},
	}
})

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Tester', type: 'human' }),
}))

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	})
	return (
		<QueryClientProvider client={client}>
			<PendingCommentsProvider workspaceId="ws-1">{children}</PendingCommentsProvider>
		</QueryClientProvider>
	)
}

function renderDraftAndFeed(draftId: string, objectId: string) {
	return renderHook(
		() => ({
			draft: useDraft({ draftId, workspaceId: 'ws-1', objectId }),
			feed: usePendingCommentsForObject(objectId),
		}),
		{ wrapper },
	)
}

describe('PendingCommentsProvider', () => {
	beforeEach(() => {
		uploadProgressMock.mockReset()
		eventsCreateMock.mockReset()
	})

	it('uploads on attach, advances status to uploaded, and exposes file id', async () => {
		uploadProgressMock.mockResolvedValue({ id: 'file-1' })
		const { result } = renderDraftAndFeed('d1', 'obj-1')

		await act(async () => {
			result.current.draft.attach(new File(['hi'], 'a.txt', { type: 'text/plain' }))
		})

		// File enters as 'uploading' optimistically
		expect(result.current.draft.files[0].status).toBe('uploading')

		await waitFor(() => {
			expect(result.current.draft.files[0].status).toBe('uploaded')
		})
		expect(result.current.draft.files[0].fileId).toBe('file-1')
	})

	it('submit moves the draft into the feed and posts after uploads complete', async () => {
		uploadProgressMock.mockResolvedValue({ id: 'file-1' })
		eventsCreateMock.mockResolvedValue({})
		const { result } = renderDraftAndFeed('d2', 'obj-2')

		await act(async () => {
			result.current.draft.attach(new File(['hi'], 'a.txt', { type: 'text/plain' }))
		})
		await waitFor(() => expect(result.current.draft.files[0].status).toBe('uploaded'))

		await act(async () => {
			result.current.draft.submit({ content: 'see attached', mentions: [] })
		})

		await waitFor(() => expect(eventsCreateMock).toHaveBeenCalledTimes(1))
		expect(eventsCreateMock.mock.calls[0][0]).toMatchObject({
			entity_id: 'obj-2',
			content: 'see attached',
			attachment_file_ids: ['file-1'],
		})
	})

	it('submit before upload completes shows the entry in the feed as still pending', async () => {
		// Upload never resolves — simulates a slow upload.
		uploadProgressMock.mockImplementation(() => new Promise<{ id: string }>(() => {}))
		eventsCreateMock.mockResolvedValue({})

		const { result } = renderDraftAndFeed('d3', 'obj-3')

		await act(async () => {
			result.current.draft.attach(new File(['hi'], 'a.txt', { type: 'text/plain' }))
		})

		await act(async () => {
			result.current.draft.submit({ content: 'wait', mentions: [] })
		})

		// Visible in the feed as a submitted entry; POST is not made yet.
		expect(result.current.feed.length).toBe(1)
		expect(result.current.feed[0].status).toBe('submitted')
		expect(eventsCreateMock).not.toHaveBeenCalled()
	})

	it('removeAttachment drops the file from the draft', async () => {
		uploadProgressMock.mockResolvedValue({ id: 'file-1' })
		const { result } = renderDraftAndFeed('d4', 'obj-4')

		await act(async () => {
			result.current.draft.attach(new File(['hi'], 'a.txt', { type: 'text/plain' }))
		})
		const tempId = result.current.draft.files[0].tempId

		await act(async () => {
			result.current.draft.remove(tempId)
		})
		expect(result.current.draft.files).toHaveLength(0)
	})
})
