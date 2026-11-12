import { FilesList } from '@/components/files/files-list'
import { api } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			files: { list: vi.fn(), tags: vi.fn().mockResolvedValue([]) },
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
		tags: [] as string[],
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

	describe('tag filter', () => {
		beforeEach(() => {
			vi.mocked(api.files.list).mockResolvedValue([fileRow('f-1', 'clip.mov')])
			vi.mocked(api.files.tags).mockResolvedValue([
				{ tag: 'interview', count: 2 },
				{ tag: 'b-roll', count: 5 },
			])
		})

		it('shows no tag filter while no file carries a tag', async () => {
			vi.mocked(api.files.tags).mockResolvedValue([])
			render(<FilesList workspaceId={WORKSPACE_ID} />, { wrapper: createWorkspaceWrapper() })
			await screen.findByText('clip.mov')
			expect(screen.queryByTestId('file-tag-filter')).toBeNull()
		})

		it('offers existing tags A to Z with counts and asks the server for the picked ones', async () => {
			const user = userEvent.setup()
			render(<FilesList workspaceId={WORKSPACE_ID} />, { wrapper: createWorkspaceWrapper() })

			await user.click(await screen.findByRole('button', { name: 'Filter by tag' }))
			const boxes = await screen.findAllByRole('checkbox')
			expect(boxes).toHaveLength(2)
			const rows = boxes.map((box) => box.closest('li')?.textContent)
			expect(rows).toEqual(['b-roll5', 'interview2'])

			await user.click(boxes[0])
			await waitFor(() =>
				expect(api.files.list).toHaveBeenLastCalledWith(
					WORKSPACE_ID,
					expect.objectContaining({ tags: ['b-roll'], tags_match: 'all' }),
				),
			)

			await user.click(screen.getByRole('radio', { name: 'Has any of these' }))
			await waitFor(() =>
				expect(api.files.list).toHaveBeenLastCalledWith(
					WORKSPACE_ID,
					expect.objectContaining({ tags: ['b-roll'], tags_match: 'any' }),
				),
			)
		})

		it('says so when no file has the picked tags', async () => {
			const user = userEvent.setup()
			render(<FilesList workspaceId={WORKSPACE_ID} />, { wrapper: createWorkspaceWrapper() })
			vi.mocked(api.files.list).mockResolvedValue([])
			await user.click(await screen.findByRole('button', { name: 'Filter by tag' }))
			await user.click((await screen.findAllByRole('checkbox'))[0])
			expect(await screen.findByText('No files have these tags')).toBeTruthy()
		})
	})
})
