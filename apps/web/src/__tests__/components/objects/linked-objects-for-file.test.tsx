import { LinkedObjectsForFile } from '@/components/objects/linked-objects'
import { api } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

// The file-detail Linked section fetches through three hooks:
//   - `useRelationships` → api.relationships.list({ object_id: fileId })
//   - `useObjects`       → api.objects.list()
//   - `useFiles`         → api.files.list()
// Mock the whole api module so every hook resolves against controllable data.
vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			relationships: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
			objects: { list: vi.fn() },
			files: { list: vi.fn() },
		},
	}
})

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>working</span>,
}))

const FILE_ID = '00000000-0000-4000-8000-000000000001'
const OBJ_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_FILE_ID = '00000000-0000-4000-8000-000000000003'

describe('LinkedObjectsForFile', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders reciprocal rows for a bet linked to the file, under the Linked (N) heading', async () => {
		// Anchor bet points at the file via an `attached` edge — the shape
		// Task 1's object-detail flow writes. LinkedObjectsForFile must render
		// the bet as a reciprocal row from the file's perspective.
		vi.mocked(api.relationships.list).mockResolvedValue([
			buildRelationshipResponse({
				id: 'rel-1',
				sourceId: OBJ_ID,
				sourceType: 'object',
				targetId: FILE_ID,
				targetType: 'file',
				type: 'attached',
			}),
		])
		vi.mocked(api.objects.list).mockResolvedValue([
			buildObjectResponse({ id: OBJ_ID, title: 'Anchor bet', type: 'bet', status: 'signal' }),
		])
		vi.mocked(api.files.list).mockResolvedValue([])

		render(<LinkedObjectsForFile fileId={FILE_ID} />, { wrapper: createWorkspaceWrapper() })

		await waitFor(() => expect(screen.getByText('Linked (1)')).toBeInTheDocument())
		expect(screen.getByText('Anchor bet')).toBeInTheDocument()
		// The `+` menu's primary CTA is `Link to object` on file-detail —
		// inverse of the object-detail default (`Link to file`).
		expect(screen.queryByRole('menuitem', { name: /Link to file/ })).toBeNull()
	})

	it('opens the picker on the Objects tab when the header button fires openPickerSignal', async () => {
		const user = userEvent.setup()
		vi.mocked(api.relationships.list).mockResolvedValue([])
		vi.mocked(api.objects.list).mockResolvedValue([
			buildObjectResponse({ id: OBJ_ID, title: 'Anchor bet', type: 'bet' }),
		])
		vi.mocked(api.files.list).mockResolvedValue([])

		const { rerender } = render(<LinkedObjectsForFile fileId={FILE_ID} openPickerSignal={null} />, {
			wrapper: createWorkspaceWrapper(),
		})

		// No picker in the DOM yet.
		expect(screen.queryByPlaceholderText(/Search objects/)).toBeNull()

		// Bump the signal — simulates the file-detail page's `Link to object`
		// button click. The picker opens with the Objects tab pressed.
		rerender(
			<LinkedObjectsForFile fileId={FILE_ID} openPickerSignal={{ kind: 'object', nonce: 1 }} />,
		)
		await waitFor(() => expect(screen.getByPlaceholderText(/Search objects/)).toBeInTheDocument())
		expect(screen.getByRole('button', { name: /Objects/ })).toHaveAttribute('aria-pressed', 'true')
		// User can still switch to Files — the tab strip is unchanged; the
		// file-detail wrapper only flips the initial default.
		await user.click(screen.getByRole('button', { name: /Files/ }))
		expect(screen.getByRole('button', { name: /Files/ })).toHaveAttribute('aria-pressed', 'true')
	})

	it('resolves file-to-file reciprocal rows via the files hook, not the graph endpoint', async () => {
		// A file→file edge from a sibling file to this one. Because no graph
		// endpoint exists for a file id, LinkedObjectsForFile composes the row
		// by fetching workspace files and picking the ones on the other end
		// of an edge. The row must render even though `useObjects` has no
		// entry for it.
		vi.mocked(api.relationships.list).mockResolvedValue([
			buildRelationshipResponse({
				id: 'rel-2',
				sourceId: OTHER_FILE_ID,
				sourceType: 'file',
				targetId: FILE_ID,
				targetType: 'file',
				type: 'relates_to',
			}),
		])
		vi.mocked(api.objects.list).mockResolvedValue([])
		vi.mocked(api.files.list).mockResolvedValue([
			{
				id: OTHER_FILE_ID,
				workspaceId: 'ws-1',
				name: 'sibling.md',
				description: null,
				mimeType: 'text/markdown',
				sizeBytes: 42,
				storageKey: 'k',
				createdBy: 'actor-1',
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
			},
		])

		render(<LinkedObjectsForFile fileId={FILE_ID} />, { wrapper: createWorkspaceWrapper() })

		await waitFor(() => expect(screen.getByText('Linked (1)')).toBeInTheDocument())
		expect(screen.getByText('sibling.md')).toBeInTheDocument()
	})
})
