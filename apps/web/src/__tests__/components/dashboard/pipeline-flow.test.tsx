import { PipelineFlow } from '@/components/dashboard/pipeline-flow'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const useBetsMock = vi.fn()
const useUpdateObjectMock = vi.fn()
const useRelationshipsMock = vi.fn()

vi.mock('@/hooks/use-bets', () => ({
	useBets: (...args: unknown[]) => useBetsMock(...args),
}))

vi.mock('@/hooks/use-objects', () => ({
	useUpdateObject: (...args: unknown[]) => useUpdateObjectMock(...args),
}))

vi.mock('@/hooks/use-relationships', () => ({
	useRelationships: (...args: unknown[]) => useRelationshipsMock(...args),
}))

function setUp({
	bets = [],
	relationships = [],
	betsLoading = false,
	relsLoading = false,
}: {
	bets?: ReturnType<typeof buildObjectResponse>[]
	relationships?: ReturnType<typeof buildRelationshipResponse>[]
	betsLoading?: boolean
	relsLoading?: boolean
} = {}) {
	useBetsMock.mockReturnValue({ data: bets, isLoading: betsLoading })
	useRelationshipsMock.mockReturnValue({ data: relationships, isLoading: relsLoading })
	useUpdateObjectMock.mockReturnValue({ mutate: vi.fn(), isPending: false })
}

describe('PipelineFlow', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows empty state when no bets exist', () => {
		setUp({ bets: [] })
		render(<PipelineFlow />, { wrapper: TestWrapper })
		expect(screen.getByText('No bets in flight')).toBeInTheDocument()
	})

	it('renders the three pipeline columns with the right counts', () => {
		const bets = [
			buildObjectResponse({ id: 'p1', type: 'bet', status: 'proposed', title: 'Proposed One' }),
			buildObjectResponse({ id: 'p2', type: 'bet', status: 'proposed', title: 'Proposed Two' }),
			buildObjectResponse({ id: 'a1', type: 'bet', status: 'active', title: 'Active One' }),
			buildObjectResponse({ id: 'd1', type: 'bet', status: 'completed', title: 'Done One' }),
			buildObjectResponse({ id: 'd2', type: 'bet', status: 'archived', title: 'Archived One' }),
		]
		setUp({ bets })
		render(<PipelineFlow />, { wrapper: TestWrapper })

		expect(screen.getByText('Proposed')).toBeInTheDocument()
		expect(screen.getByText('In Progress')).toBeInTheDocument()
		expect(screen.getByText('Done')).toBeInTheDocument()

		expect(screen.getByText('Proposed One')).toBeInTheDocument()
		expect(screen.getByText('Active One')).toBeInTheDocument()
		expect(screen.getByText('Done One')).toBeInTheDocument()
		expect(screen.getByText('Archived One')).toBeInTheDocument()
	})

	it('shows up to 5 bets per column with overflow link', () => {
		const bets = Array.from({ length: 8 }, (_, i) =>
			buildObjectResponse({
				id: `p${i}`,
				type: 'bet',
				status: 'proposed',
				title: `Bet ${i}`,
				metadata: { order: 100 - i },
			}),
		)
		setUp({ bets })
		render(<PipelineFlow />, { wrapper: TestWrapper })

		expect(screen.getByText('Bet 0')).toBeInTheDocument()
		expect(screen.getByText('Bet 4')).toBeInTheDocument()
		expect(screen.queryByText('Bet 5')).not.toBeInTheDocument()
		expect(screen.getByText('+3 more →')).toBeInTheDocument()
	})

	it('renders the "See all in Missions" link', () => {
		setUp({
			bets: [buildObjectResponse({ id: 'p1', type: 'bet', status: 'proposed', title: 'Bet' })],
		})
		render(<PipelineFlow />, { wrapper: TestWrapper })
		expect(screen.getByText('See all in Missions →')).toBeInTheDocument()
	})

	it('orders bets within a column by metadata.order DESC', () => {
		const bets = [
			buildObjectResponse({
				id: 'low',
				type: 'bet',
				status: 'proposed',
				title: 'Low Priority',
				metadata: { order: 10 },
			}),
			buildObjectResponse({
				id: 'high',
				type: 'bet',
				status: 'proposed',
				title: 'High Priority',
				metadata: { order: 100 },
			}),
		]
		setUp({ bets })
		render(<PipelineFlow />, { wrapper: TestWrapper })
		const items = screen.getAllByRole('listitem')
		expect(items[0]).toHaveTextContent('High Priority')
		expect(items[1]).toHaveTextContent('Low Priority')
	})

	it('renders touch-friendly drag handles on every bet', () => {
		const bets = [
			buildObjectResponse({ id: 'p1', type: 'bet', status: 'proposed', title: 'Bet One' }),
			buildObjectResponse({ id: 'p2', type: 'bet', status: 'active', title: 'Bet Two' }),
		]
		setUp({ bets })
		render(<PipelineFlow />, { wrapper: TestWrapper })
		const handles = screen.getAllByRole('button', { name: /Reorder/ })
		expect(handles.length).toBe(2)
		for (const handle of handles) {
			expect(handle.className).toMatch(/min-h-\[44px\]/)
			expect(handle.className).toMatch(/min-w-\[44px\]/)
		}
	})

	it('shows task count for each bet from breaks_into relationships', () => {
		const bets = [buildObjectResponse({ id: 'b1', type: 'bet', status: 'active', title: 'Bet' })]
		const relationships = [
			buildRelationshipResponse({ sourceId: 'b1', targetId: 't1', type: 'breaks_into' }),
			buildRelationshipResponse({ sourceId: 'b1', targetId: 't2', type: 'breaks_into' }),
			buildRelationshipResponse({ sourceId: 'b1', targetId: 'i1', type: 'informs' }),
		]
		setUp({ bets, relationships })
		render(<PipelineFlow />, { wrapper: TestWrapper })
		const items = screen.getAllByRole('listitem')
		expect(within(items[0]).getByText('2 tasks')).toBeInTheDocument()
	})
})
