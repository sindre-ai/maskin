import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: { id: 'ws-1', name: 'Test', settings: {} },
	}),
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/work/index'

const RouteOptions = Route as unknown as { component: React.FC }
const WorkBoardPage = RouteOptions.component

describe('WorkBoardPage', () => {
	it('renders the Work page header and placeholder copy', () => {
		render(<WorkBoardPage />)
		expect(screen.getByRole('heading', { name: 'Work' })).toBeInTheDocument()
		expect(screen.getByText('Work board (coming soon)')).toBeInTheDocument()
	})

	it('mentions the current workspace id in the placeholder copy', () => {
		render(<WorkBoardPage />)
		expect(screen.getByText(/ws-1/)).toBeInTheDocument()
	})
})
