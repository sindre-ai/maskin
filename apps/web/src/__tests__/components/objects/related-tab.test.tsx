import { RelatedTab } from '@/components/objects/related-tab'
import { useObjectGraph, useObjects } from '@/hooks/use-objects'
import { useCreateRelationship, useDeleteRelationship } from '@/hooks/use-relationships'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-objects', () => ({
	useObjectGraph: vi.fn(),
	useObjects: vi.fn(),
}))

vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: vi.fn(),
	useDeleteRelationship: vi.fn(),
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>working</span>,
}))

function mockGraph(
	rels: ReturnType<typeof buildRelationshipResponse>[],
	connected: ReturnType<typeof buildObjectResponse>[],
) {
	vi.mocked(useObjectGraph).mockReturnValue({
		data: { relationships: rels, connected_objects: connected, events: [] },
	} as never)
}

const mutate = vi.fn()

beforeEach(() => {
	mutate.mockReset()
	vi.mocked(useObjects).mockReturnValue({ data: [] } as never)
	vi.mocked(useCreateRelationship).mockReturnValue({ mutate } as never)
	vi.mocked(useDeleteRelationship).mockReturnValue({ mutate } as never)
})

describe('RelatedTab', () => {
	it('shows a live count in the header for existing relationships', () => {
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		const linkedA = buildObjectResponse({ id: 'obj-2', title: 'Alpha' })
		const linkedB = buildObjectResponse({ id: 'obj-3', title: 'Beta' })
		mockGraph(
			[
				buildRelationshipResponse({ id: 'r1', sourceId: 'obj-1', targetId: 'obj-2' }),
				buildRelationshipResponse({ id: 'r2', sourceId: 'obj-3', targetId: 'obj-1' }),
			],
			[linkedA, linkedB],
		)

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Related (2)')).toBeInTheDocument()
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
	})

	it('renders the type / name / status / when columns', () => {
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		const linked = buildObjectResponse({ id: 'obj-2', title: 'Alpha' })
		mockGraph(
			[buildRelationshipResponse({ id: 'r1', sourceId: 'obj-1', targetId: 'obj-2' })],
			[linked],
		)

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		// Column headers — sort buttons expose the label text.
		expect(screen.getByRole('button', { name: /^Title$/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Type$/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Status$/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^When$/i })).toBeInTheDocument()
	})

	it('renders the empty state with an add-link CTA when no relationships exist', () => {
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph([], [])

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Related (0)')).toBeInTheDocument()
		expect(screen.getByText(/No related objects yet/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Add link/i })).toBeInTheDocument()
	})

	it('CTA in the empty state reveals the add-link form', async () => {
		const user = userEvent.setup()
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph([], [])

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		await user.click(screen.getByRole('button', { name: /Add link/i }))

		expect(screen.getByPlaceholderText(/Search objects/i)).toBeInTheDocument()
	})

	it('fires the remove mutation when the row remove button is clicked', () => {
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		const linked = buildObjectResponse({ id: 'obj-2', title: 'Alpha' })
		mockGraph(
			[buildRelationshipResponse({ id: 'r1', sourceId: 'obj-1', targetId: 'obj-2' })],
			[linked],
		)

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		fireEvent.click(screen.getByRole('button', { name: /Remove link/i }))

		expect(mutate).toHaveBeenCalledWith('r1')
	})
})
