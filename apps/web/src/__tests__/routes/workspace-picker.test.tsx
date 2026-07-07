import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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

import { Route as IndexRoute } from '@/routes/_authed/index'
import { Route as WorkspacesRoute } from '@/routes/_authed/workspaces'

const WorkspacePicker = (WorkspacesRoute as unknown as { component: React.FC }).component
const IndexRedirect = (IndexRoute as unknown as { component: React.FC }).component

describe('WorkspacePicker', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows loading skeleton when workspaces are loading', () => {
		mockUseWorkspaces.mockReturnValue({ data: undefined, isLoading: true })
		render(<WorkspacePicker />)
		expect(screen.getByTestId('skeleton')).toBeInTheDocument()
		expect(screen.queryByText('Choose workspace')).not.toBeInTheDocument()
	})

	it('redirects to /signup when user has no workspaces', () => {
		mockUseWorkspaces.mockReturnValue({ data: [], isLoading: false })
		render(<WorkspacePicker />)
		const nav = screen.getByTestId('navigate')
		expect(nav).toHaveAttribute('data-to', '/signup')
	})

	it('auto-redirects when exactly one workspace', () => {
		mockUseWorkspaces.mockReturnValue({
			data: [{ id: 'ws-1', name: 'My Workspace', role: 'admin' }],
			isLoading: false,
		})
		render(<WorkspacePicker />)
		const nav = screen.getByTestId('navigate')
		expect(nav).toHaveAttribute('data-to', '/$workspaceId')
		expect(nav).toHaveAttribute('data-params', JSON.stringify({ workspaceId: 'ws-1' }))
	})

	it('renders workspace list for multiple workspaces', () => {
		mockUseWorkspaces.mockReturnValue({
			data: [
				{ id: 'ws-1', name: 'Workspace One', role: 'admin' },
				{ id: 'ws-2', name: 'Workspace Two', role: 'member' },
			],
			isLoading: false,
		})
		render(<WorkspacePicker />)
		expect(screen.getByText('Choose workspace')).toBeInTheDocument()
		expect(screen.getByText('Workspace One')).toBeInTheDocument()
		expect(screen.getByText('Role: admin')).toBeInTheDocument()
		expect(screen.getByText('Workspace Two')).toBeInTheDocument()
		expect(screen.getByText('Role: member')).toBeInTheDocument()
	})
})

describe('_authed index redirect', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows loading skeleton when workspaces are loading', () => {
		mockUseWorkspaces.mockReturnValue({ data: undefined, isLoading: true })
		render(<IndexRedirect />)
		expect(screen.getByTestId('skeleton')).toBeInTheDocument()
	})

	it('redirects directly to the workspace when exactly one exists', () => {
		mockUseWorkspaces.mockReturnValue({
			data: [{ id: 'ws-1', name: 'My Workspace', role: 'admin' }],
			isLoading: false,
		})
		render(<IndexRedirect />)
		const nav = screen.getByTestId('navigate')
		expect(nav).toHaveAttribute('data-to', '/$workspaceId')
		expect(nav).toHaveAttribute('data-params', JSON.stringify({ workspaceId: 'ws-1' }))
	})

	it('redirects to /workspaces when multiple workspaces exist', () => {
		mockUseWorkspaces.mockReturnValue({
			data: [
				{ id: 'ws-1', name: 'Workspace One', role: 'admin' },
				{ id: 'ws-2', name: 'Workspace Two', role: 'member' },
			],
			isLoading: false,
		})
		render(<IndexRedirect />)
		const nav = screen.getByTestId('navigate')
		expect(nav).toHaveAttribute('data-to', '/workspaces')
	})
})
