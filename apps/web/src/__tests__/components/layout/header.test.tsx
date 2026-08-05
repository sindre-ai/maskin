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
	usePageHeader: vi.fn(() => ({ actions: null, stickyIdentity: null })),
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
		vi.mocked(useMatches).mockReturnValue([
			{ routeId: '/_authed/$workspaceId/', pathname: '/ws-1', params: { workspaceId: 'ws-1' } },
		] as ReturnType<typeof useMatches>)
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
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: 'Custom Action' })).toBeInTheDocument()
	})

	it('only shows the hamburger SidebarTrigger below md', () => {
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})
		render(<Header />)
		const trigger = screen.getByRole('button', { name: /toggle sidebar/i })
		expect(trigger.className).toMatch(/\bmd:hidden\b/)
	})

	it('hides the Create button on object-detail pages', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
			{
				routeId: '/_authed/$workspaceId/objects/$objectId',
				pathname: '/ws-1/objects/obj-1',
				params: { workspaceId: 'ws-1', objectId: 'obj-1' },
			},
		] as ReturnType<typeof useMatches>)
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		expect(screen.queryByRole('button', { name: /create new/i })).not.toBeInTheDocument()
	})

	it('keeps the Create button on the objects list surface', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
		] as ReturnType<typeof useMatches>)
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: /create new/i })).toBeInTheDocument()
	})

	it('keeps the Create button on the agents list surface', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/agents',
				pathname: '/ws-1/agents',
				params: { workspaceId: 'ws-1' },
			},
		] as ReturnType<typeof useMatches>)
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: /create new/i })).toBeInTheDocument()
	})

	it('keeps the Create button on the triggers list surface', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/triggers/',
				pathname: '/ws-1/triggers',
				params: { workspaceId: 'ws-1' },
			},
		] as ReturnType<typeof useMatches>)
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: /create new/i })).toBeInTheDocument()
	})

	it('renders the sticky identity projection when the hero has scrolled off', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
			{
				routeId: '/_authed/$workspaceId/objects/$objectId',
				pathname: '/ws-1/objects/obj-1',
				params: { workspaceId: 'ws-1', objectId: 'obj-1' },
			},
		] as ReturnType<typeof useMatches>)
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: <div data-testid="sticky-identity">Sticky nav bet</div>,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		// Rendered twice — a desktop slot (md+) and a mobile slot (md:hidden) —
		// so the header can swap between them via responsive CSS without extra JS.
		const slots = screen.getAllByTestId('sticky-identity')
		expect(slots.length).toBeGreaterThan(0)
	})
})
