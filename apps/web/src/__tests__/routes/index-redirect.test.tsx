import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseWorkspaces = vi.fn()

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaces: () => mockUseWorkspaces(),
}))

vi.mock('@/components/shared/loading-skeleton', () => ({
	Skeleton: ({ className }: { className?: string }) => (
		<div data-testid="skeleton" className={className} />
	),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		Navigate: ({ to, params }: { to: string; params?: Record<string, string> }) => (
			<div data-testid="navigate" data-to={to} data-params={JSON.stringify(params)} />
		),
	}
})

vi.mock('@/components/layout/create-first-workspace', () => ({
	CreateFirstWorkspace: () => <p>Create your first workspace</p>,
}))

import { Route as IndexRoute } from '@/routes/_authed/index'

const IndexRedirect = (IndexRoute as unknown as { component: React.FC }).component

const twoWorkspaces = [
	{ id: 'ws-1', name: 'Workspace One', role: 'admin' },
	{ id: 'ws-2', name: 'Workspace Two', role: 'member' },
]

describe('_authed index redirect', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
	})

	it('shows loading skeleton when workspaces are loading', () => {
		mockUseWorkspaces.mockReturnValue({ data: undefined, isLoading: true })
		render(<IndexRedirect />)
		expect(screen.getByTestId('skeleton')).toBeInTheDocument()
	})

	it('shows the create-first-workspace screen instead of redirecting when there are none', () => {
		mockUseWorkspaces.mockReturnValue({ data: [], isLoading: false })
		render(<IndexRedirect />)
		expect(screen.queryByTestId('navigate')).not.toBeInTheDocument()
		expect(screen.getByText('Create your first workspace')).toBeInTheDocument()
	})

	it('redirects directly to the workspace when exactly one exists', () => {
		mockUseWorkspaces.mockReturnValue({ data: [twoWorkspaces[0]], isLoading: false })
		render(<IndexRedirect />)
		const nav = screen.getByTestId('navigate')
		expect(nav).toHaveAttribute('data-to', '/$workspaceId')
		expect(nav).toHaveAttribute('data-params', JSON.stringify({ workspaceId: 'ws-1' }))
	})

	it('redirects to the last used workspace when the user has several', () => {
		localStorage.setItem('maskin-last-workspace', 'ws-2')
		mockUseWorkspaces.mockReturnValue({ data: twoWorkspaces, isLoading: false })
		render(<IndexRedirect />)
		const nav = screen.getByTestId('navigate')
		expect(nav).toHaveAttribute('data-to', '/$workspaceId')
		expect(nav).toHaveAttribute('data-params', JSON.stringify({ workspaceId: 'ws-2' }))
	})

	it('falls back to the first workspace when none was used before', () => {
		mockUseWorkspaces.mockReturnValue({ data: twoWorkspaces, isLoading: false })
		render(<IndexRedirect />)
		expect(screen.getByTestId('navigate')).toHaveAttribute(
			'data-params',
			JSON.stringify({ workspaceId: 'ws-1' }),
		)
	})

	it('falls back to the first workspace when the remembered one is no longer accessible', () => {
		localStorage.setItem('maskin-last-workspace', 'ws-gone')
		mockUseWorkspaces.mockReturnValue({ data: twoWorkspaces, isLoading: false })
		render(<IndexRedirect />)
		expect(screen.getByTestId('navigate')).toHaveAttribute(
			'data-params',
			JSON.stringify({ workspaceId: 'ws-1' }),
		)
	})
})
