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

		// The count lives on the group label — the segmented control above the
		// tab carries the total (mockup 1157–1159).
		expect(screen.getByText('2')).toBeInTheDocument()
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
	})

	it('renders each row as type / name / status / when, under its edge label', () => {
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		const linked = buildObjectResponse({ id: 'obj-2', title: 'Alpha' })
		mockGraph(
			[buildRelationshipResponse({ id: 'r1', sourceId: 'obj-1', targetId: 'obj-2' })],
			[linked],
		)

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		// No column headers and no sort — the list is a reading of the graph.
		expect(screen.queryByRole('columnheader')).toBeNull()
		expect(screen.getByText('informs')).toBeInTheDocument()
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument()
	})

	it('renders every configured group with its dashed CTA row when no relationships exist', () => {
		// D11: an empty group is actionable, not just labelled. With no rows, the
		// tab still iterates over every configured relationship type and hangs the
		// two dashed CTAs off each one — so a fresh object exposes a Link / Upload
		// affordance per group, per type, on first read.
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph([], [])

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		const linkCtas = screen.getAllByRole('button', { name: /Link an object as /i })
		const uploadCtas = screen.getAllByRole('button', { name: /Upload a file as /i })
		expect(linkCtas.length).toBeGreaterThan(0)
		expect(linkCtas.length).toBe(uploadCtas.length)
	})

	it("a group's Link CTA reveals the add-link form pre-scoped to that group's type", async () => {
		const user = userEvent.setup()
		const owner = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph([], [])

		render(<RelatedTab object={owner} />, { wrapper: createWorkspaceWrapper() })

		await user.click(screen.getAllByRole('button', { name: /Link an object as /i })[0])

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
	// Regression: a pending or failed graph fetch yields the same empty
	// `resolved` array as a genuinely unlinked object. "No related objects yet"
	// is a claim about the user's data and must not be made over either — it
	// also shipped an "Add link" CTA for links that may already exist.
	it('shows a skeleton while the graph loads, not the empty state', () => {
		vi.mocked(useObjectGraph).mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		} as never)

		const { container } = render(<RelatedTab object={buildObjectResponse({ id: 'obj-1' })} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(screen.queryByText(/No related objects yet/)).toBeNull()
		// The v2 tab has no "Related (N)" heading of its own — the count lives in
		// the segmented control above it — so the skeleton is what marks the
		// pending state here.
		expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
	})

	it('surfaces an error when the graph fetch fails, not the empty state', () => {
		vi.mocked(useObjectGraph).mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error('boom'),
		} as never)

		render(<RelatedTab object={buildObjectResponse({ id: 'obj-1' })} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(screen.queryByText('No related objects yet')).toBeNull()
		expect(screen.getByText("Couldn't load related objects")).toBeInTheDocument()
	})
})
