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
		// Full crumb chain lives in the desktop container (parent Settings + leaf Members)
		expect(screen.getByText('Settings')).toBeInTheDocument()
		// Leaf renders in both the desktop chain and the mobile leaf-only container
		expect(screen.getAllByText('Members')).toHaveLength(2)
	})

	it('renders the leaf crumb in a mobile-only container so it is visible below md', () => {
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
		const mobileLeaf = screen.getAllByText('Members').find((el) => {
			// walk up to the flex-container that gates on md:hidden
			let node: HTMLElement | null = el
			while (node) {
				if (node.className && /\bmd:hidden\b/.test(node.className)) return true
				node = node.parentElement
			}
			return false
		})
		expect(mobileLeaf).toBeDefined()
	})

	it('renders the desktop crumb row visible at rest (no opacity-0 hover-only wrapper)', () => {
		vi.mocked(useMatches).mockReturnValue([
			{ routeId: '/_authed/$workspaceId/', pathname: '/ws-1', params: { workspaceId: 'ws-1' } },
		] as ReturnType<typeof useMatches>)

		const { container } = render(<Header />)
		// The desktop crumb container must not gate visibility on hover — no `opacity-0` at rest,
		// and no `transition-opacity` residue anywhere in the header.
		const html = container.innerHTML
		expect(html).not.toMatch(/\bopacity-0\b/)
		expect(html).not.toMatch(/\btransition-opacity\b/)
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

	it('adds iOS safe-area top padding so the h-11 bar clears the notch (min-h-11 + pt-env)', () => {
		const { container } = render(<Header />)
		const header = container.querySelector('header')
		expect(header).not.toBeNull()
		expect(header?.className).toMatch(/\bmin-h-11\b/)
		expect(header?.className).toMatch(/pt-\[env\(safe-area-inset-top\)\]/)
	})
})
