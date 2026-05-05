import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/components/work-board/board', () => ({
	Board: () => <div data-testid="work-board">Board</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/work/index'

const RouteOptions = Route as unknown as { component: React.FC }
const WorkBoardPage = RouteOptions.component

describe('WorkBoardPage', () => {
	it('renders the Work page header', () => {
		render(<WorkBoardPage />)
		expect(screen.getByRole('heading', { name: 'Work' })).toBeInTheDocument()
	})

	it('renders the board component', () => {
		render(<WorkBoardPage />)
		expect(screen.getByTestId('work-board')).toBeInTheDocument()
	})
})
