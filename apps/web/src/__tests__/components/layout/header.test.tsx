import { Header } from '@/components/layout/header'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
	useMatches: vi.fn(() => [
		{ routeId: '/_authed/$workspaceId/', pathname: '/ws-1', params: { workspaceId: 'ws-1' } },
	]),
	useNavigate: () => vi.fn(),
	useRouter: () => ({ history: { back: vi.fn() } }),
}))

vi.mock('@/lib/page-header-context', () => ({
	usePageHeader: vi.fn(() => ({ actions: null })),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/components/ui/sidebar', () => ({
	SidebarTrigger: () => <button type="button">Toggle sidebar</button>,
}))

import { useMatches } from '@tanstack/react-router'
import { usePageHeader } from '@/lib/page-header-context'

describe('Header', () => {
	it('renders Create dropdown button', () => {
		render(<Header />)
		expect(screen.getByRole('button', { name: /create new/i })).toBeInTheDocument()
	})

	it('shows breadcrumbs from route matches', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/settings/',
				pathname: '/ws-1/settings',
				params: { workspaceId: 'ws-1' },
			},
			{
				routeId: '/_authed/$workspaceId/settings/members',
				pathname: '/ws-1/settings/members',
				params: { workspaceId: 'ws-1' },
			},
		] as ReturnType<typeof useMatches>)

		render(<Header />)
		expect(screen.getByText('Settings')).toBeInTheDocument()
		expect(screen.getByText('Members')).toBeInTheDocument()
	})

	it('renders page header actions from usePageHeader', () => {
		vi.mocked(usePageHeader).mockReturnValue({
			actions: <button type="button">Custom Action</button>,
			setActions: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: 'Custom Action' })).toBeInTheDocument()
	})
})
