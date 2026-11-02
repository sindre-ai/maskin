import { MobileNav, showsMobileNav } from '@/components/layout/mobile-nav'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getEnabledObjectTypeTabs decides the conditional Objects item — mirror the
// module-sdk contract (returns the work module's tabs when 'work' is enabled).
const mockGetEnabledObjectTypeTabs = vi.fn((moduleIds: string[]) =>
	moduleIds.includes('work') ? [{ label: 'Bets', value: 'bet' }] : [],
)
vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: (moduleIds: string[]) => mockGetEnabledObjectTypeTabs(moduleIds),
}))

const mockUseEnabledModules = vi.fn()
vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => mockUseEnabledModules(),
}))

const trackNav = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackNavItemClicked: (p: { item_key: string; source: string }) => trackNav(p),
}))

const mockSetOpenMobile = vi.fn()
vi.mock('@/components/ui/sidebar', () => ({
	useSidebar: () => ({ setOpenMobile: mockSetOpenMobile }),
}))

let mockPathname = '/ws-1'
const mockMatch = vi.fn<({ to }: { to?: string }) => boolean>()
const linkCalls: Array<{ to?: string; params?: Record<string, string>; label?: string }> = []
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		to,
		params,
		'aria-label': ariaLabel,
		...rest
	}: {
		children: React.ReactNode
		to?: string
		params?: Record<string, string>
		'aria-label'?: string
	}) => {
		linkCalls.push({ to, params, label: ariaLabel })
		return (
			<a href={to} aria-label={ariaLabel} {...rest}>
				{children}
			</a>
		)
	},
	useMatchRoute: () => mockMatch,
	useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
		select({ location: { pathname: mockPathname } }),
}))
beforeEach(() => {
	linkCalls.length = 0
	mockPathname = '/ws-1'
	mockSetOpenMobile.mockReset()
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

afterEach(() => {
	trackNav.mockReset()
	mockUseEnabledModules.mockReset()
	mockMatch.mockReset()
})

describe('MobileNav', () => {
	it('renders the three base items when no object-type module is enabled', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		expect(screen.getByRole('link', { name: /for you/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /chats/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /flows/i })).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /items/i })).not.toBeInTheDocument()
	})

	it('has no Triggers tab — v2 routes triggers through Loops', () => {
		mockUseEnabledModules.mockReturnValue(['work'])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		expect(screen.queryByRole('link', { name: /triggers/i })).not.toBeInTheDocument()
		expect(linkCalls.map((c) => c.to)).not.toContain('/$workspaceId/triggers')
	})

	it('puts the Items item last, after Flows when object types are enabled', () => {
		mockUseEnabledModules.mockReturnValue(['work'])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		const links = screen.getAllByRole('link')
		const labels = links.map((l) => l.getAttribute('aria-label'))
		expect(labels).toEqual([
			'For you, navigate to',
			'Chats, navigate to',
			'Flows, navigate to',
			'Items, navigate to',
		])
	})

	it('marks the current page link and keeps others as navigate-to', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockImplementation(({ to }) => to === '/$workspaceId/chats')
		render(<MobileNav />)
		expect(screen.getByRole('link', { name: 'Chats, current page' })).toHaveAttribute(
			'aria-current',
			'page',
		)
		expect(screen.getByRole('link', { name: 'For you, navigate to' })).not.toHaveAttribute(
			'aria-current',
		)
		expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-haspopup', 'dialog')
		expect(screen.getByRole('link', { name: 'For you, navigate to' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Flows, navigate to' })).toBeInTheDocument()
	})

	it('emits nav_item_clicked with the bottom-nav source on tap', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		fireEvent.click(screen.getByRole('link', { name: /flows/i }))
		expect(trackNav).toHaveBeenCalledWith({ item_key: 'loops', source: 'bottom-nav' })
	})

	it('links every item with the workspaceId param', () => {
		mockUseEnabledModules.mockReturnValue(['work'])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		expect(linkCalls).toHaveLength(4)
		const hrefs = linkCalls.map((c) => c.to)
		expect(hrefs).toContain('/$workspaceId/objects')
		expect(hrefs).toContain('/$workspaceId/chats')
		expect(hrefs).toContain('/$workspaceId/loops')
		for (const call of linkCalls) {
			expect(call.params).toEqual({ workspaceId: 'ws-1' })
		}
	})

	it('ends with a More button that opens the sidebar drawer', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		fireEvent.click(screen.getByRole('button', { name: 'More' }))
		expect(mockSetOpenMobile).toHaveBeenCalledWith(true)
	})

	it('draws nothing on a screen that owns a composer', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockReturnValue(false)
		mockPathname = '/ws-1/chats/abc'
		const { container } = render(<MobileNav />)
		expect(container).toBeEmptyDOMElement()
	})
})

describe('showsMobileNav', () => {
	it.each([
		'/ws-1',
		'/ws-1/',
		'/ws-1/chats',
		'/ws-1/loops',
		'/ws-1/objects',
		'/ws-1/agents',
		'/ws-1/marketplace',
	])('shows on the list page %s', (path) => {
		expect(showsMobileNav(path, 'ws-1')).toBe(true)
	})

	it.each([
		'/ws-1/chats/abc',
		'/ws-1/chats/new',
		'/ws-1/objects/abc',
		'/ws-1/loops/abc',
		'/ws-1/agents/abc',
		'/ws-1/sessions/abc',
		'/ws-1/files/abc',
		'/ws-1/settings',
		'/ws-1/settings/keys',
		'/ws-1/search',
		'/ws-1/marketplace/abc',
		'/other',
	])('hides on %s', (path) => {
		expect(showsMobileNav(path, 'ws-1')).toBe(false)
	})
})
