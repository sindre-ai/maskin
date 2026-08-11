import { MobileNav } from '@/components/layout/mobile-nav'
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
}))
beforeEach(() => {
	linkCalls.length = 0
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
	it('renders the four base items when no object-type module is enabled', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		expect(screen.getByRole('link', { name: /for you/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /loops/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /triggers/i })).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /objects/i })).not.toBeInTheDocument()
	})

	it('injects the Objects item after For You when object types are enabled', () => {
		mockUseEnabledModules.mockReturnValue(['work'])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		const links = screen.getAllByRole('link')
		const labels = links.map((l) => l.getAttribute('aria-label'))
		expect(labels).toEqual([
			'For You, navigate to',
			'Objects, navigate to',
			'Agents, navigate to',
			'Loops, navigate to',
			'Triggers, navigate to',
		])
	})

	it('marks the current page link and keeps others as navigate-to', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockImplementation(({ to }) => to === '/$workspaceId/agents')
		render(<MobileNav />)
		expect(screen.getByRole('link', { name: 'Agents, current page' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'For You, navigate to' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Loops, navigate to' })).toBeInTheDocument()
	})

	it('emits nav_item_clicked with the bottom-nav source on tap', () => {
		mockUseEnabledModules.mockReturnValue([])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		fireEvent.click(screen.getByRole('link', { name: /loops/i }))
		expect(trackNav).toHaveBeenCalledWith({ item_key: 'loops', source: 'bottom-nav' })
	})

	it('links every item with the workspaceId param', () => {
		mockUseEnabledModules.mockReturnValue(['work'])
		mockMatch.mockReturnValue(false)
		render(<MobileNav />)
		expect(linkCalls).toHaveLength(5)
		const hrefs = linkCalls.map((c) => c.to)
		expect(hrefs).toContain('/$workspaceId/objects')
		expect(hrefs).toContain('/$workspaceId/agents')
		expect(hrefs).toContain('/$workspaceId/triggers')
		for (const call of linkCalls) {
			expect(call.params).toEqual({ workspaceId: 'ws-1' })
		}
	})
})
