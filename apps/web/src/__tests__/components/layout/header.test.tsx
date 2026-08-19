import { Header } from '@/components/layout/header'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const navigateMock = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	useMatches: vi.fn(() => [
		{
			routeId: '/_authed/$workspaceId/objects/',
			pathname: '/ws-1/objects',
			params: { workspaceId: 'ws-1' },
		},
	]),
	useNavigate: () => navigateMock,
	useRouter: () => ({ history: { back: vi.fn() } }),
}))

vi.mock('@/lib/page-header-context', () => ({
	usePageHeader: vi.fn(() => ({ actions: null, stickyIdentity: null })),
}))

vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
	],
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
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
	it('renders the split New control — a primary half and a menu half', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
		] as ReturnType<typeof useMatches>)
		render(<Header />)
		expect(screen.getByRole('button', { name: 'More ways to start' })).toBeInTheDocument()
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

	it('navigates to a new chat from the New menu', async () => {
		navigateMock.mockClear()
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: 'More ways to start' }))
		await user.click(screen.getByRole('menuitem', { name: /new chat/i }))

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId: 'ws-1' },
		})
	})

	it('opens CreatePicker seeded to the right object subtype', async () => {
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: 'More ways to start' }))
		await user.click(screen.getByRole('menuitem', { name: /new insight/i }))

		const picker = screen.getByTestId('create-picker')
		expect(picker).toHaveAttribute('data-type', 'object')
		expect(picker).toHaveAttribute('data-subtype', 'insight')
	})

	it('opens CreatePicker as a loop from New loop', async () => {
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: 'More ways to start' }))
		await user.click(screen.getByRole('menuitem', { name: /new loop/i }))

		expect(screen.getByTestId('create-picker')).toHaveAttribute('data-type', 'loop')
	})

	it('opens CreatePicker as an agent from New agent', async () => {
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: 'More ways to start' }))
		await user.click(screen.getByRole('menuitem', { name: /new agent/i }))

		expect(screen.getByTestId('create-picker')).toHaveAttribute('data-type', 'agent')
	})

	it('opens the command palette from Find a past conversation', async () => {
		setPaletteOpen.mockClear()
		const user = userEvent.setup()
		render(<Header />)

		await user.click(screen.getByRole('button', { name: 'More ways to start' }))
		await user.click(screen.getByRole('menuitem', { name: /find a past conversation/i }))

		expect(setPaletteOpen).toHaveBeenCalledWith(true)
	})

	it('renders page header actions from usePageHeader', () => {
		vi.mocked(usePageHeader).mockReturnValue({
			actions: <button type="button">Custom Action</button>,
			stickyIdentity: null,
			setTitle: vi.fn(),
			setSubtitle: vi.fn(),
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setCrumb: vi.fn(),
			setContentPush: vi.fn(),
			setScrollLocked: vi.fn(),
		})

		render(<Header />)
		expect(screen.getByRole('button', { name: 'Custom Action' })).toBeInTheDocument()
	})

	it('only shows the hamburger SidebarTrigger below md', () => {
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setTitle: vi.fn(),
			setSubtitle: vi.fn(),
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setCrumb: vi.fn(),
			setContentPush: vi.fn(),
			setScrollLocked: vi.fn(),
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
			setTitle: vi.fn(),
			setSubtitle: vi.fn(),
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setCrumb: vi.fn(),
			setContentPush: vi.fn(),
			setScrollLocked: vi.fn(),
		})

		const user = userEvent.setup()
		render(<Header />)

		expect(screen.getByRole('button', { name: 'More ways to start' })).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'More ways to start' }))

		expect(screen.getByRole('menuitem', { name: /new chat/i })).toBeInTheDocument()
		expect(screen.queryByText('Create an object')).not.toBeInTheDocument()
		expect(screen.queryByRole('menuitem', { name: /new insight/i })).not.toBeInTheDocument()
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
			setTitle: vi.fn(),
			setSubtitle: vi.fn(),
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setCrumb: vi.fn(),
			setContentPush: vi.fn(),
			setScrollLocked: vi.fn(),
		})

		const user = userEvent.setup()
		render(<Header />)
		await user.click(screen.getByRole('button', { name: 'More ways to start' }))

		expect(screen.getByText('Create an object')).toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: /new insight/i })).toBeInTheDocument()
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
			setTitle: vi.fn(),
			setSubtitle: vi.fn(),
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setCrumb: vi.fn(),
			setContentPush: vi.fn(),
			setScrollLocked: vi.fn(),
		})

		render(<Header />)
		// Rendered twice — a desktop slot (md+) and a mobile slot (md:hidden) —
		// so the header can swap between them via responsive CSS without extra JS.
		const slots = screen.getAllByTestId('sticky-identity')
		expect(slots.length).toBeGreaterThan(0)
	})

	// v2 puts the ⌘K chip inside the expanded workspace-search field (mockup
	// lines 206–212), so it is two steps by mouse. Keyboard users still reach the
	// palette through its own global ⌘K listener.
	it('opens the command palette from the ⌘K chip inside the expanded search', async () => {
		setPaletteOpen.mockClear()
		const user = userEvent.setup()
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
		] as unknown as ReturnType<typeof useMatches>)
		render(<Header />)

		await user.click(screen.getByRole('button', { name: 'Search the workspace' }))
		await user.click(screen.getByRole('button', { name: 'Open commands' }))

		expect(setPaletteOpen).toHaveBeenCalledWith(true)
	})

	it('collapses the workspace search to an icon until it is opened', async () => {
		const user = userEvent.setup()
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
		] as unknown as ReturnType<typeof useMatches>)
		render(<Header />)

		expect(screen.queryByRole('textbox', { name: 'Search the workspace' })).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Search the workspace' }))
		expect(screen.getByRole('textbox', { name: 'Search the workspace' })).toBeInTheDocument()
	})

	// For You used to render its own create affordance, so the nav suppressed the
	// split New there. That page-level duplicate is gone, so the nav owns it on
	// every screen now — one create control, one place.
	it('renders the split New control on For You too', () => {
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/',
				pathname: '/ws-1',
				params: { workspaceId: 'ws-1' },
			},
		] as unknown as ReturnType<typeof useMatches>)
		render(<Header />)
		expect(screen.getByRole('button', { name: 'More ways to start' })).toBeInTheDocument()
	})

	it('renders the screen title as the nav row heading', () => {
		// A sticky identity from an earlier case would take the title's slot.
		vi.mocked(usePageHeader).mockReturnValue({
			actions: null,
			stickyIdentity: null,
			setTitle: vi.fn(),
			setSubtitle: vi.fn(),
			setActions: vi.fn(),
			setStickyIdentity: vi.fn(),
			setCrumb: vi.fn(),
			setContentPush: vi.fn(),
			setScrollLocked: vi.fn(),
		})
		vi.mocked(useMatches).mockReturnValue([
			{
				routeId: '/_authed/$workspaceId/objects/',
				pathname: '/ws-1/objects',
				params: { workspaceId: 'ws-1' },
			},
		] as unknown as ReturnType<typeof useMatches>)
		render(<Header />)
		expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
	})
})
