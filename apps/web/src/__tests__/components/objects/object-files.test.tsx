import { ObjectFiles } from '@/components/objects/object-files'
import type { FileListItem, RelationshipResponse } from '@/lib/api'
import { render, waitFor } from '@testing-library/react'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/api', () => ({
	api: {
		files: {
			list: vi.fn(),
		},
		relationships: {
			create: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/api'

function buildRel(overrides: Partial<RelationshipResponse> = {}): RelationshipResponse {
	return {
		id: `rel-${Math.random().toString(36).slice(2)}`,
		sourceType: 'object',
		sourceId: 'obj-1',
		targetType: 'file',
		targetId: 'file-1',
		type: 'attached',
		createdBy: 'actor-1',
		createdAt: null,
		...overrides,
	}
}

function buildFileItem(overrides: Partial<FileListItem> = {}): FileListItem {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'diagram.png',
		description: null,
		mimeType: 'image/png',
		sizeBytes: 4096,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('ObjectFiles — endpoint resolution by id', () => {
	it('renders an attached file whose edge is stamped with the canonical `file` label', async () => {
		const rel = buildRel({
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'file',
			targetId: 'file-1',
			type: 'attached',
		})
		const file = buildFileItem({ id: 'file-1', name: 'canonical.png' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		const { findByText } = render(
			<TestWrapper>
				<ObjectFiles
					workspaceId="ws-1"
					objectId="obj-1"
					objectType="bet"
					relationships={{ asSource: [rel], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await findByText('canonical.png')
		expect(api.files.list).toHaveBeenCalledWith('ws-1', { ids: ['file-1'] })
	})

	it('renders an attached file whose edge is stamped with a legacy non-`file` label', async () => {
		// Bet-creation stamps `sourceType` with the endpoint's specialised type
		// even when the endpoint is a file — a legacy pattern the write path is
		// being normalised away in a sibling task. The read layer must still
		// surface the attachment, driven by the endpoint id, not the label.
		const rel = buildRel({
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'bet', // legacy mislabel — endpoint is actually a file
			targetId: 'file-1',
			type: 'attached',
		})
		const file = buildFileItem({ id: 'file-1', name: 'legacy.png' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		const { findByText } = render(
			<TestWrapper>
				<ObjectFiles
					workspaceId="ws-1"
					objectId="obj-1"
					objectType="bet"
					relationships={{ asSource: [rel], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		// The candidate id list is sent to the server; the server-side files
		// query self-filters non-files, so we don't need to gate on the label.
		await findByText('legacy.png')
		expect(api.files.list).toHaveBeenCalledWith('ws-1', { ids: ['file-1'] })
	})

	it('resolves a file endpoint that appears as the edge source (asTarget)', async () => {
		const rel = buildRel({
			id: 'rel-inbound',
			sourceType: 'file', // canonical
			sourceId: 'file-2',
			targetType: 'object',
			targetId: 'obj-1',
			type: 'attached',
		})
		const file = buildFileItem({ id: 'file-2', name: 'inbound.png' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		const { findByText } = render(
			<TestWrapper>
				<ObjectFiles
					workspaceId="ws-1"
					objectId="obj-1"
					objectType="bet"
					relationships={{ asSource: [], asTarget: [rel] }}
				/>
			</TestWrapper>,
		)

		await findByText('inbound.png')
		expect(api.files.list).toHaveBeenCalledWith('ws-1', { ids: ['file-2'] })
	})

	it('ignores non-attached relationships regardless of their labels', async () => {
		const informs = buildRel({
			id: 'rel-informs',
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'object',
			targetId: 'obj-2',
			type: 'informs',
		})
		vi.mocked(api.files.list).mockResolvedValue([])

		render(
			<TestWrapper>
				<ObjectFiles
					workspaceId="ws-1"
					objectId="obj-1"
					objectType="bet"
					relationships={{ asSource: [informs], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		// Empty ids → `useFiles` short-circuits and never calls the API.
		await waitFor(() => {
			expect(api.files.list).not.toHaveBeenCalled()
		})
	})
})
