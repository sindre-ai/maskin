import { Header } from '@/components/layout/header'
import { fireEvent, render, screen } from '@testing-library/react'
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

const setChatOpen = vi.fn()
vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ setOpen: setChatOpen }),
}))

vi.mock('@/components/ui/sidebar', () => ({
	SidebarTrigger: ({ className }: { className?: string }) => (
		<button type="button" className={className}>
			Toggle sidebar
		</button>
	),
}))

// Stub the picker so header tests don't need QueryClient/workspace-context setup —
// header responsibility is opening it, not the create flow itself (covered elsewhere).
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: ({ open }: { open: boolean }) =>
		open ? <div data-testid="create-picker" /> : null,
}))

import { usePageHeader } from '@/lib/page-header-context'
import { useMatches } from '@tanstack/react-router'

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

	it('renders a chat launcher that opens the panel without navigating', () => {
		setChatOpen.mockClear()
		render(<Header />)
		const launcher = screen.getByRole('button', { name: /open chat/i })
		fireEvent.click(launcher)
		expect(setChatOpen).toHaveBeenCalledWith(true)
	})

	it('renders page header actions from usePageHeader', () => {
		vi.mocked(usePageHeader).mockReturnValue({
			actions: <button type="button">Custom Action</button>,
			setActions: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: 'Custom Action' })).toBeInTheDocument()
	})

	it('only shows the hamburger SidebarTrigger below md', () => {
		render(<Header />)
		const trigger = screen.getByRole('button', { name: /toggle sidebar/i })
		expect(trigger.className).toMatch(/\bmd:hidden\b/)
	})
})
