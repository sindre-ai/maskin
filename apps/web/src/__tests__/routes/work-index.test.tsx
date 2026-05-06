import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseSearch = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => mockUseSearch(),
	}
})

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/components/work-board/board', () => ({
	Board: ({ filters }: { filters?: Record<string, unknown> }) => (
		<div data-testid="work-board" data-filters={JSON.stringify(filters ?? {})}>
			Board
		</div>
	),
}))

vi.mock('@/components/work-board/filter-bar', () => ({
	FilterBar: () => <div data-testid="filter-bar" />,
}))

import { Route } from '@/routes/_authed/$workspaceId/work/index'
import { createWorkspaceWrapper } from '../setup'

const RouteOptions = Route as unknown as {
	component: React.FC
	validateSearch: (search: Record<string, unknown>) => unknown
}
const WorkBoardPage = RouteOptions.component
const validateSearch = RouteOptions.validateSearch

const wrapper = () => createWorkspaceWrapper({ id: 'ws-1' })

describe('WorkBoardPage / route', () => {
	it('renders the Work page header', () => {
		mockUseSearch.mockReturnValue({})
		render(<WorkBoardPage />, { wrapper: wrapper() })
		expect(screen.getByRole('heading', { name: 'Work' })).toBeInTheDocument()
	})

	it('renders the board component', () => {
		mockUseSearch.mockReturnValue({})
		render(<WorkBoardPage />, { wrapper: wrapper() })
		expect(screen.getByTestId('work-board')).toBeInTheDocument()
	})

	it('forwards URL filters to the Board', () => {
		mockUseSearch.mockReturnValue({ bet: 'b1', assignee: 'mine', status: 'blocked' })
		render(<WorkBoardPage />, { wrapper: wrapper() })
		const board = screen.getByTestId('work-board')
		const filters = JSON.parse(board.getAttribute('data-filters') ?? '{}')
		expect(filters).toEqual({ bet: 'b1', assignee: 'mine', status: 'blocked' })
	})
})

describe('WorkBoardPage / validateSearch (URL ↔ filter round-trip)', () => {
	it('parses bet/assignee/status from query strings', () => {
		expect(validateSearch({ bet: 'bet-1', assignee: 'mine', status: 'blocked' })).toEqual({
			bet: 'bet-1',
			assignee: 'mine',
			status: 'blocked',
		})
	})

	it('treats empty strings as undefined', () => {
		expect(validateSearch({ bet: '', assignee: '', status: '' })).toEqual({
			bet: undefined,
			assignee: undefined,
			status: undefined,
		})
	})

	it('rejects unknown status values', () => {
		expect(validateSearch({ status: 'completed' })).toEqual({
			bet: undefined,
			assignee: undefined,
			status: undefined,
		})
	})

	it('accepts the three valid status values', () => {
		for (const status of ['blocked', 'active', 'all'] as const) {
			expect(validateSearch({ status })).toMatchObject({ status })
		}
	})

	it('ignores non-string fields', () => {
		expect(validateSearch({ bet: 42, assignee: { foo: 1 }, status: ['x'] })).toEqual({
			bet: undefined,
			assignee: undefined,
			status: undefined,
		})
	})
})
