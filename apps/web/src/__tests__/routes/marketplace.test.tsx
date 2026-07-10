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
	useInstallCatalogItem: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
	useInstalledCatalogItems: () => ({ data: undefined, isLoading: false }),
	useUninstallCatalogItem: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}))

vi.mock('@/hooks/use-installed-packages', () => ({
	useInstalledPackages: () => ({ data: { installs: [] }, isLoading: false, isError: false }),
	useInstallPackage: () => ({ mutate: vi.fn(), isPending: false }),
	useForkInstalledPackage: () => ({ mutate: vi.fn(), isPending: false }),
}))

// useQueries is used to fetch individual items from multi-type packages.
// Default to returning no data so most tests stay simple.
const mockUseQueries = vi.fn((): unknown[] => [])
vi.mock('@tanstack/react-query', async () => {
	const actual = await vi.importActual('@tanstack/react-query')
	return { ...actual, useQueries: () => mockUseQueries() }
})

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
		mockUseQueries.mockReturnValue([])
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
		expect(screen.getAllByText('Type').length).toBeGreaterThan(0)
		expect(screen.getAllByText('Use case').length).toBeGreaterThan(0)

		// Desktop sidebar items render as buttons. The "All" label appears twice
		// (Type + Use case groups).
		expect(screen.getAllByRole('button', { name: /^All\s/ }).length).toBeGreaterThanOrEqual(2)
		// Type counts fall back to by_type when no items are loaded.
		expect(screen.getAllByRole('button', { name: /^Agents\s5/ }).length).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByRole('button', { name: /^Triggers\s2/ }).length).toBeGreaterThanOrEqual(1)
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
		expect(screen.getAllByRole('button', { name: /^Agents$/ }).length).toBeGreaterThanOrEqual(1)
		expect(screen.getByText(/Couldn't load the catalog/i)).toBeInTheDocument()
	})

	it('places a multi-type package in the Packages section, not in Agents or Triggers', () => {
		mockUseCatalogPackages.mockReturnValue({
			data: {
				packages: [
					{
						id: 'p1',
						name: 'Customer Continuous Discovery',
						slug: 'continuous-discovery',
						description: 'Loop',
						version: '1.0.0',
						use_case: 'Discovery',
						item_types: ['actor', 'trigger'],
						created_at: null,
						updated_at: null,
					},
				],
				counts: COUNTS,
			},
			isLoading: false,
			isError: false,
		})
		render(<MarketplacePage />)
		expect(screen.getByRole('region', { name: 'Packages' })).toHaveTextContent(
			'Customer Continuous Discovery',
		)
		expect(screen.queryByRole('region', { name: 'Agents' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('shows individual items in typed sections when package details are loaded', () => {
		mockUseCatalogPackages.mockReturnValue({
			data: {
				packages: [
					{
						id: 'p1',
						name: 'Customer Continuous Discovery',
						slug: 'continuous-discovery',
						description: 'Loop',
						version: '1.0.0',
						use_case: 'Discovery',
						item_types: ['actor', 'trigger'],
						created_at: null,
						updated_at: null,
					},
				],
				counts: COUNTS,
			},
			isLoading: false,
			isError: false,
		})
		mockUseQueries.mockReturnValue([
			{
				data: {
					package: { id: 'p1', name: 'CCD' },
					items: [
						{
							id: 'i1',
							package_id: 'p1',
							item_type: 'actor',
							source_item_id: 'src-1',
							item_snapshot: { name: 'Feedback Agent', description: 'Handles feedback' },
							created_at: null,
						},
						{
							id: 'i2',
							package_id: 'p1',
							item_type: 'trigger',
							source_item_id: 'src-2',
							item_snapshot: { name: 'Daily Sweep', description: 'Runs daily' },
							created_at: null,
						},
					],
				},
			},
		])
		render(<MarketplacePage />)
		expect(screen.getByRole('region', { name: 'Packages' })).toHaveTextContent(
			'Customer Continuous Discovery',
		)
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('Feedback Agent')
		expect(screen.getByRole('region', { name: 'Triggers' })).toHaveTextContent('Daily Sweep')
	})

	it('shows the empty-state copy when the catalog has no packages', () => {
		render(<MarketplacePage />)
		expect(screen.getByText(/No packages yet/i)).toBeInTheDocument()
	})

	it('hides the desktop sidebar via the md:hidden / hidden md:block split', () => {
		render(<MarketplacePage />)
		const chipNav = screen.getByRole('navigation', { name: 'Marketplace filters' })
		expect(chipNav.className).toMatch(/md:hidden/)
		const aside = chipNav.parentElement?.querySelector('aside')
		expect(aside).not.toBeNull()
		expect(aside?.className).toMatch(/hidden/)
		expect(aside?.className).toMatch(/md:block/)
	})

	it('mobile filter chips carry the pointer-coarse ≥44px tap-target floor', () => {
		render(<MarketplacePage />)
		const chipNav = screen.getByRole('navigation', { name: 'Marketplace filters' })
		const chipButtons = chipNav.querySelectorAll<HTMLButtonElement>('button[type="button"]')
		expect(chipButtons.length).toBeGreaterThan(0)
		for (const chip of chipButtons) {
			expect(chip.className).toContain('pointer-coarse:min-h-11')
			expect(chip.className).toContain('pointer-coarse:inline-flex')
			expect(chip.className).toContain('pointer-coarse:items-center')
			expect(chip.className).toContain('py-1')
			expect(chip.className).toContain('text-xs')
		}
	})
})
