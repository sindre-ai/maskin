import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockUseCatalogPackages = vi.fn()
vi.mock('@/hooks/use-catalog-packages', () => ({
	useCatalogPackages: () => mockUseCatalogPackages(),
}))

import { Route } from '@/routes/_authed/$workspaceId/marketplace'

const MarketplacePage = (Route as unknown as { component: React.FC }).component

const COUNTS = {
	total: 4,
	by_type: { actor: 5, trigger: 2, skill: 6, integration: 3 },
	by_use_case: { Discovery: 1, Sales: 2, Research: 0, 'Lifecycle comms': 1 },
}

describe('MarketplacePage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseCatalogPackages.mockReturnValue({
			data: { packages: [], counts: COUNTS },
			isLoading: false,
			isError: false,
		})
	})

	it('renders the page heading and subhead', () => {
		render(<MarketplacePage />)
		expect(screen.getByRole('heading', { name: 'Marketplace' })).toBeInTheDocument()
		expect(screen.getByText(/Vetted agents, triggers, skills/)).toBeInTheDocument()
	})

	it('renders Type and Use case sidebar groups with counts from the API', () => {
		render(<MarketplacePage />)
		// Two groups; each label rendered once in the desktop sidebar and once in
		// the mobile chip strip — query by role/text below for the sidebar items.
		expect(screen.getAllByText('Type').length).toBeGreaterThan(0)
		expect(screen.getAllByText('Use case').length).toBeGreaterThan(0)

		// Desktop sidebar items render as buttons. The "All" label appears twice
		// (Type + Use case groups).
		expect(screen.getAllByRole('button', { name: /^All\s/ }).length).toBeGreaterThanOrEqual(2)
		expect(screen.getAllByRole('button', { name: /^Agents\s5/ }).length).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByRole('button', { name: /^Triggers\s2/ }).length).toBeGreaterThanOrEqual(
			1,
		)
		expect(screen.getAllByRole('button', { name: /^Skills\s6/ }).length).toBeGreaterThanOrEqual(1)
		expect(
			screen.getAllByRole('button', { name: /^Integrations\s3/ }).length,
		).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByRole('button', { name: /^Discovery\s1/ }).length).toBeGreaterThanOrEqual(
			1,
		)
		expect(screen.getAllByRole('button', { name: /^Sales\s2/ }).length).toBeGreaterThanOrEqual(1)
	})

	it('clicking a Type item marks it active in the desktop sidebar', async () => {
		render(<MarketplacePage />)
		const user = userEvent.setup()
		const agentsButtons = screen.getAllByRole('button', { name: /^Agents\s5/ })
		// In DOM order the chip-strip button comes first, the sidebar button second.
		const sidebarBtn = agentsButtons[agentsButtons.length - 1]
		await user.click(sidebarBtn)
		expect(sidebarBtn.className).toMatch(/bg-muted/)
		expect(sidebarBtn.className).toMatch(/font-medium/)
	})

	it('renders sidebar without counts when the API request errors', () => {
		mockUseCatalogPackages.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		})
		render(<MarketplacePage />)
		// Sidebar items still render
		expect(screen.getAllByRole('button', { name: /^Agents$/ }).length).toBeGreaterThanOrEqual(1)
		// Error message shown in content area
		expect(screen.getByText(/Couldn't load the catalog/i)).toBeInTheDocument()
	})

	it('shows a content placeholder while the grid lands in T8', () => {
		render(<MarketplacePage />)
		expect(screen.getByText(/Marketplace items will appear here/i)).toBeInTheDocument()
	})

	it('hides the desktop sidebar via the md:hidden / hidden md:block split', () => {
		render(<MarketplacePage />)
		// The chip-strip nav element is hidden ≥md
		const chipNav = screen.getByRole('navigation', { name: 'Marketplace filters' })
		expect(chipNav.className).toMatch(/md:hidden/)
		// The aside (desktop sidebar) is hidden <md and shown md:block
		const aside = chipNav.parentElement?.querySelector('aside')
		expect(aside).not.toBeNull()
		expect(aside?.className).toMatch(/hidden/)
		expect(aside?.className).toMatch(/md:block/)
	})
})
