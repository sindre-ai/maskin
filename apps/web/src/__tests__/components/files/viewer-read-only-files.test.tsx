import { EditableMarkdownStage } from '@/components/files/editable-markdown-stage'
import { ReviewPanel } from '@/components/files/review-panel'
import { ObjectFiles } from '@/components/objects/object-files'
import type { FileCommentDto, FileDetail, FileListItem } from '@/lib/api'
import { resolveProvenance } from '@/lib/viewer-provenance'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', async () => ({
	getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }),
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))

const createFileMock = vi.fn()
const uploadFileMock = vi.fn()
vi.mock('@/hooks/use-files', () => ({
	useFile: () => ({ data: undefined }),
	useFiles: () => ({ data: [] as FileListItem[] }),
	useCreateFile: () => ({ mutateAsync: createFileMock }),
	useUploadFile: () => uploadFileMock,
}))

vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ isSuccess: true, data: null }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn() }),
}))

const viewer = () => createWorkspaceWrapper({ role: 'viewer' })
const member = () => createWorkspaceWrapper({ role: 'member' })

function buildFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'spec.md',
		description: null,
		mimeType: 'text/markdown',
		sizeBytes: 12,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: '2026-06-10T10:00:00.000Z',
		updatedAt: '2026-06-15T10:00:00.000Z',
		content: '# Title\n\nbody text',
		encoding: 'utf8',
		contentHash: 'h0',
		...overrides,
	} as FileDetail
}

describe('viewer fixture: file controls are disabled, not hidden', () => {
	it('disables the attach button and ignores a dropped file', () => {
		createFileMock.mockReset()
		uploadFileMock.mockReset()
		render(<ObjectFiles workspaceId="ws-1" objectId="obj-1" objectType="bet" />, {
			wrapper: viewer(),
		})
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeDisabled()

		const dropped = new File(['hi'], 'hi.txt', { type: 'text/plain' })
		const dropZone = screen.getByRole('button', { name: 'Attach file' }).closest('div.rounded-md')
		fireEvent.drop(dropZone as Element, { dataTransfer: { files: [dropped] } })
		expect(createFileMock).not.toHaveBeenCalled()
		expect(uploadFileMock).not.toHaveBeenCalled()
	})

	it('keeps the attach button enabled for a member', () => {
		render(<ObjectFiles workspaceId="ws-1" objectId="obj-1" objectType="bet" />, {
			wrapper: member(),
		})
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled()
	})

	it('opens a markdown file as the rendered document, with no editor, for a viewer', async () => {
		const { container } = render(<EditableMarkdownStage file={buildFile()} />, {
			wrapper: viewer(),
		})
		expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument()
		expect(container.querySelector('[contenteditable="true"]')).toBeNull()
	})

	it('opens the same file in the editor for a member', async () => {
		const { container } = render(<EditableMarkdownStage file={buildFile()} />, {
			wrapper: member(),
		})
		await waitFor(() => expect(container.querySelector('[contenteditable="true"]')).not.toBeNull())
	})

	it('disables Resolve and Reopen on review comments for a viewer, enables them for a member', () => {
		const open: FileCommentDto = {
			id: 'c1',
			fileId: 'file-1',
			page: 0,
			positionDoc: { x: 0.2, y: 0.2 },
			selector: null,
			authorId: 'actor-1',
			body: 'Open comment',
			parentId: null,
			roundId: null,
			resolvedAt: null,
			resolvedBy: null,
			createdAt: '2026-09-01T09:00:00.000Z',
			updatedAt: '2026-09-01T09:00:00.000Z',
		}
		const done: FileCommentDto = {
			...open,
			id: 'c2',
			body: 'Done comment',
			resolvedAt: '2026-09-10T09:00:00.000Z',
			resolvedBy: 'actor-2',
		}
		const panel = (
			<ReviewPanel
				fileId="file-1"
				workspaceId="ws-1"
				comments={[open, done]}
				drafts={[]}
				filter="all"
				onFilterChange={() => {}}
				provenance={resolveProvenance([])}
				sendState={{ phase: 'idle', lockedDriverName: null, lockedDriverType: null }}
				onSendRound={() => {}}
				onUpdateDraftBody={() => {}}
				onRemoveDraft={() => {}}
				onPostDraft={() => {}}
				onResolveComment={() => {}}
				onReopenComment={() => {}}
				roundFilter={null}
				onClearRoundFilter={() => {}}
			/>
		)
		const { unmount } = render(panel, { wrapper: viewer() })
		expect(screen.getByRole('button', { name: /Resolve/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Reopen' })).toBeDisabled()
		unmount()

		render(panel, { wrapper: member() })
		expect(screen.getByRole('button', { name: /Resolve/ })).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Reopen' })).toBeEnabled()
	})
})
