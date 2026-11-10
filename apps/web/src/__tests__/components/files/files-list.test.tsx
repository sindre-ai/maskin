import { FilesList } from '@/components/files/files-list'
import { api } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			files: { list: vi.fn() },
			actors: { list: vi.fn().mockResolvedValue([]) },
		},
	}
})

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa'

function fileRow(id: string, name: string) {
	return {
		id,
		workspaceId: WORKSPACE_ID,
		name,
		description: null,
		mimeType: 'text/markdown',
		sizeBytes: 2048,
		storageKey: `workspaces/${WORKSPACE_ID}/files/${id}`,
		createdBy: '00000000-0000-4000-8000-0000000000bb',
		createdAt: '2026-11-01T10:00:00.000Z',
		updatedAt: '2026-11-02T10:00:00.000Z',
	}
}

describe('FilesList', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('lists files A to Z by name', async () => {
		vi.mocked(api.files.list).mockResolvedValue([
			fileRow('f-2', 'zebra.md'),
			fileRow('f-1', 'Apple.md'),
			fileRow('f-3', 'mango.md'),
		])
		render(<FilesList workspaceId={WORKSPACE_ID} />, { wrapper: createWorkspaceWrapper() })

		const links = await screen.findAllByRole('link')
		expect(links.map((l) => l.textContent)).toEqual([
			expect.stringContaining('Apple.md'),
			expect.stringContaining('mango.md'),
			expect.stringContaining('zebra.md'),
		])
	})

	it('shows an empty state when the workspace has no files', async () => {
		vi.mocked(api.files.list).mockResolvedValue([])
		render(<FilesList workspaceId={WORKSPACE_ID} />, { wrapper: createWorkspaceWrapper() })

		expect(await screen.findByText('No files yet')).toBeInTheDocument()
	})

	it('names the search in the empty state', async () => {
		vi.mocked(api.files.list).mockResolvedValue([])
		render(<FilesList workspaceId={WORKSPACE_ID} q="plan" />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('No files match “plan”.')).toBeInTheDocument()
	})
})
