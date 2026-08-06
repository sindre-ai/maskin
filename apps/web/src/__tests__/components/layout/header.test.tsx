import { Header } from '@/components/layout/header'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
	useMatches: vi.fn(() => [
		{
			routeId: '/_authed/$workspaceId/objects/',
			pathname: '/ws-1/objects',
			params: { workspaceId: 'ws-1' },
		},
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

const setPaletteOpen = vi.fn()
vi.mock('@/lib/command-palette-context', () => ({
	useCommandPalette: () => ({ open: false, setOpen: setPaletteOpen }),
}))

vi.mock('@/components/ui/sidebar', () => ({
	SidebarTrigger: ({ className }: { className?: string }) => (
		<button type="button" className={className}>
			Toggle sidebar
		</button>
	),
}))

// Stub the picker so header tests don't need QueryClient/workspace-context setup —
// header responsibility is opening it with the right config, not the create
// flow itself (covered elsewhere). Renders the config it was opened with so
// tests can assert which creatable type/subtype the header requested.
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: ({
		open,
		defaultType,
		defaultObjectSubtype,
	}: {
		open: boolean
		defaultType?: string
		defaultObjectSubtype?: string
	}) =>
		open ? (
			<div
				data-testid="create-picker"
				data-type={defaultType}
				data-subtype={defaultObjectSubtype}
			/>
		) : null,
}))

import { usePageHeader } from '@/lib/page-header-context'
import { useMatches } from '@tanstack/react-router'

describe('Header', () => {
	it('renders the New menu trigger', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
		] as ReturnType<typeof useMatches>)
		render(<Header />)
		expect(screen.getByRole('button', { name: /^new$/i })).toBeInTheDocument()
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

	it('opens the chat panel from the New menu without navigating', async () => {
		setChatOpen.mockClear()
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /new chat/i }))

		expect(setChatOpen).toHaveBeenCalledWith(true)
	})

	it('opens CreatePicker seeded to the right object subtype', async () => {
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /new insight/i }))

		const picker = screen.getByTestId('create-picker')
		expect(picker).toHaveAttribute('data-type', 'object')
		expect(picker).toHaveAttribute('data-subtype', 'insight')
	})

	it('opens CreatePicker as a trigger from New loop', async () => {
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /new loop/i }))

		expect(screen.getByTestId('create-picker')).toHaveAttribute('data-type', 'trigger')
	})

	it('opens CreatePicker as an agent from New agent', async () => {
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /new agent/i }))

		expect(screen.getByTestId('create-picker')).toHaveAttribute('data-type', 'agent')
	})

	it('opens the command palette from Find a past conversation', async () => {
		setPaletteOpen.mockClear()
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /find a past conversation/i }))

		expect(setPaletteOpen).toHaveBeenCalledWith(true)
	})

	it('hides the New menu on the For You page', () => {
		vi.mocked(useMatches).mockReturnValue([
			{ routeId: '/_authed/$workspaceId/', pathname: '/ws-1', params: { workspaceId: 'ws-1' } },
		] as ReturnType<typeof useMatches>)
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setContentPush: vi.fn(),
		})

		render(<Header />)
		expect(screen.queryByRole('button', { name: /^new$/i })).not.toBeInTheDocument()
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

	it('hides the "Create an object" section on object-detail pages, but keeps the New menu', async () => {
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

		const user = userEvent.setup()
		render(<Header />)

		expect(screen.getByRole('button', { name: /^new$/i })).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /^new$/i }))

		expect(screen.getByRole('menuitem', { name: /new chat/i })).toBeInTheDocument()
		expect(screen.queryByText('Create an object')).not.toBeInTheDocument()
		expect(screen.queryByRole('menuitem', { name: /new task/i })).not.toBeInTheDocument()
	})

	it('keeps the "Create an object" section on the objects list surface', async () => {
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

		const user = userEvent.setup()
		render(<Header />)
		await user.click(screen.getByRole('button', { name: /^new$/i }))

		expect(screen.getByText('Create an object')).toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: /new task/i })).toBeInTheDocument()
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
