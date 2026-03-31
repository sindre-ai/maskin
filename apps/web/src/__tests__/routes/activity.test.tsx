import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
const mockUseSearch = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: any) => options,
		useSearch: (...args: any[]) => mockUseSearch(...args),
		useNavigate: () => mockNavigate,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/components/activity/activity-feed', () => ({
	ActivityFeed: ({ workspaceId, filter }: { workspaceId: string; filter?: string }) => (
		<div data-testid="activity-feed" data-workspace={workspaceId} data-filter={filter ?? ''} />
	),
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/activity'

const ActivityPage = Route.component as React.FC

describe('ActivityPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseSearch.mockReturnValue({ filter: undefined })
	})

	it('renders Activity page header', () => {
		render(<ActivityPage />)
		expect(screen.getByText('Activity')).toBeInTheDocument()
	})

	it('renders desktop filter tabs', () => {
		render(<ActivityPage />)
		expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
	})

	it('passes filter to ActivityFeed', () => {
		mockUseSearch.mockReturnValue({ filter: 'comments' })
		render(<ActivityPage />)
		const feed = screen.getByTestId('activity-feed')
		expect(feed).toHaveAttribute('data-filter', 'comments')
	})

	it('calls navigate with filter on tab click', async () => {
		const user = userEvent.setup()
		render(<ActivityPage />)
		const decisionButton = screen.getByRole('button', { name: 'Decision' })
		await user.click(decisionButton)
		expect(mockNavigate).toHaveBeenCalled()
	})
})

describe('validateSearch', () => {
	it('returns filter when search.filter is a string', () => {
		const result = Route.validateSearch({ filter: 'comments' })
		expect(result).toEqual({ filter: 'comments' })
	})

	it('returns undefined filter when search.filter is not a string', () => {
		const result = Route.validateSearch({ filter: 123 })
		expect(result).toEqual({ filter: undefined })
	})

	it('returns undefined filter when search.filter is missing', () => {
		const result = Route.validateSearch({})
		expect(result).toEqual({ filter: undefined })
	})
})
