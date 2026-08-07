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

const mockUseMarketplaceLoops = vi.fn()
vi.mock('@/hooks/use-marketplace-loops', () => ({
	useMarketplaceLoops: () => mockUseMarketplaceLoops(),
	useInstallMarketplaceItem: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
	useInstalledMarketplaceItems: () => ({ data: undefined, isLoading: false }),
	useUninstallMarketplaceItem: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}))

vi.mock('@/hooks/use-installed-loops', () => ({
	useInstalledLoops: () => ({ data: { installs: [] }, isLoading: false, isError: false }),
	useInstallLoop: () => ({ mutate: vi.fn(), isPending: false }),
	useForkInstalledLoop: () => ({ mutate: vi.fn(), isPending: false }),
}))

// useQueries is used to fetch individual items from multi-type loops.
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
		mockUseMarketplaceLoops.mockReturnValue({
			data: { loops: [], counts: COUNTS },
			isLoading: false,
			isError: false,
		})
	})

	it('renders Type and Use case chip rows with counts from the API', () => {
		render(<MarketplacePage />)

		// "All" renders once per filter kind (Type row + Use case row).
		expect(screen.getAllByRole('button', { name: /^All\s/ })).toHaveLength(2)
		// Type counts fall back to by_type when no items are loaded.
		expect(screen.getByRole('button', { name: /^Agents\s5/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Triggers\s2/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Skills\s6/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Integrations\s3/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Discovery\s1/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Sales\s2/ })).toBeInTheDocument()
	})

	it('clicking a Type chip marks it active', async () => {
		render(<MarketplacePage />)
		const user = userEvent.setup()
		const btn = screen.getByRole('button', { name: /^Agents\s5/ })
		await user.click(btn)
		expect(btn.className).toMatch(/border-foreground/)
		expect(btn.className).toMatch(/bg-foreground/)
	})

	it('renders chips without counts when the API request errors', () => {
		mockUseMarketplaceLoops.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		})
		render(<MarketplacePage />)
		expect(screen.getByRole('button', { name: /^Agents$/ })).toBeInTheDocument()
		expect(screen.getByText(/Couldn't load the marketplace/i)).toBeInTheDocument()
	})

	it('places a multi-type loop in the Loops section, not in Agents or Triggers', () => {
		mockUseMarketplaceLoops.mockReturnValue({
			data: {
				loops: [
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
		expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent(
			'Customer Continuous Discovery',
		)
		expect(screen.queryByRole('region', { name: 'Agents' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('shows individual items in typed sections when loop details are loaded', () => {
		mockUseMarketplaceLoops.mockReturnValue({
			data: {
				loops: [
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
					loop: { id: 'p1', name: 'CCD' },
					items: [
						{
							id: 'i1',
							loop_id: 'p1',
							item_type: 'actor',
							source_item_id: 'src-1',
							item_snapshot: { name: 'Feedback Agent', description: 'Handles feedback' },
							created_at: null,
						},
						{
							id: 'i2',
							loop_id: 'p1',
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
		expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent(
			'Customer Continuous Discovery',
		)
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('Feedback Agent')
		expect(screen.getByRole('region', { name: 'Triggers' })).toHaveTextContent('Daily Sweep')
	})

	it('shows the empty-state copy when the marketplace has no loops', () => {
		render(<MarketplacePage />)
		expect(screen.getByText(/No loops yet/i)).toBeInTheDocument()
	})

	it('renders the free-text filter input inside the filter nav', () => {
		mockUseMarketplaceLoops.mockReturnValue({
			data: {
				loops: [
					{
						id: 'p1',
						name: 'Alpha',
						slug: 'alpha',
						description: '',
						version: '1',
						use_case: null,
						item_types: ['actor'],
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
		const input = screen.getByRole('searchbox', { name: 'Filter marketplace' })
		const chipNav = screen.getByRole('navigation', { name: 'Marketplace filters' })
		expect(chipNav.contains(input)).toBe(true)
	})

	it('narrows the visible loops when the user types into the filter', async () => {
		mockUseMarketplaceLoops.mockReturnValue({
			data: {
				loops: [
					{
						id: 'p1',
						name: 'Discover & Research',
						slug: 'discover',
						description: 'Insight loop',
						version: '1',
						use_case: null,
						item_types: ['actor', 'trigger'],
						created_at: null,
						updated_at: null,
					},
					{
						id: 'p2',
						name: 'Build & Ship',
						slug: 'build-ship',
						description: 'Delivery loop',
						version: '1',
						use_case: null,
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
		const loops = screen.getByRole('region', { name: 'Loops' })
		expect(loops).toHaveTextContent('Discover & Research')
		expect(loops).toHaveTextContent('Build & Ship')

		const user = userEvent.setup()
		const input = screen.getByRole('searchbox', { name: 'Filter marketplace' })
		await user.type(input, 'discover')
		expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent('Discover & Research')
		expect(screen.getByRole('region', { name: 'Loops' })).not.toHaveTextContent('Build & Ship')
	})

	it('renders a clean empty state when the query matches nothing', async () => {
		mockUseMarketplaceLoops.mockReturnValue({
			data: {
				loops: [
					{
						id: 'p1',
						name: 'Alpha',
						slug: 'alpha',
						description: '',
						version: '1',
						use_case: null,
						item_types: ['actor'],
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
		const user = userEvent.setup()
		const input = screen.getByRole('searchbox', { name: 'Filter marketplace' })
		await user.type(input, 'zzzznomatchxyz')
		expect(screen.getByText('No matches')).toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Loops' })).not.toBeInTheDocument()
		expect(screen.queryByText(/Showing all/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/No loops yet/i)).not.toBeInTheDocument()
	})
})
