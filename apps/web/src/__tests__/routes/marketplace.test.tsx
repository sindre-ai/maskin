import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route file exports a component composed from MarketplaceV3Page. Mock the
// TanStack Router file-based helper so this test doesn't need the full router
// runtime; the route object surfaces the component under `.component`.
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

// The v3 catalog hook + install mutation both go through `@/lib/api`. Mock the
// two entry points and drive them per-test. Every other api surface stays
// intact via importOriginal so unrelated hooks a component reaches for still
// work. `vi.hoisted` is what lets these fns exist in the same scope as the
// hoisted vi.mock factory without a temporal-dead-zone error.
const { listMock, installMock } = vi.hoisted(() => ({
	listMock: vi.fn(),
	installMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			marketplaceCatalog: { list: listMock },
			marketplaceInstall: { install: installMock },
		},
	}
})

import { Route } from '@/routes/_authed/$workspaceId/marketplace/index'
import { TestWrapper } from '../setup'

const MarketplacePage = (Route as unknown as { component: React.FC }).component

// A minimal server catalog payload — enough to exercise every band + tab-count
// derivation. Field names mirror the Marketplace tech spec §6.1 wire shape.
function buildCard(overrides: Record<string, unknown>) {
	return {
		item_kind: 'loop' as const,
		catalog_id: '11111111-1111-1111-1111-111111111111',
		slug: 'default-slug',
		display_name: 'Default',
		outcome_line: 'A default outcome line.',
		team: 'shared',
		requires: {},
		install_count: 0,
		...overrides,
	}
}

function buildCatalog(overrides: Record<string, unknown> = {}) {
	const loopCard = buildCard({
		item_kind: 'loop',
		catalog_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
		slug: 'churn-recovery',
		display_name: 'Churn Recovery loop',
		outcome_line: 'Spot quiet accounts before they lapse.',
		install_count: 12,
		team: 'customer',
	})
	const agentCard = buildCard({
		item_kind: 'agent',
		catalog_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
		slug: 'compass',
		display_name: 'Compass',
		outcome_line: 'Structures signals into insights.',
		install_count: 14,
	})
	const skillCard = buildCard({
		item_kind: 'skill',
		catalog_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
		slug: 'plain-english-voice',
		display_name: 'Plain English voice',
		outcome_line: "Rewrites drafts in Maskin's house style.",
		install_count: 22,
	})
	const toolCard = buildCard({
		item_kind: 'mcp_server',
		catalog_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
		slug: 'slack',
		display_name: 'Slack',
		outcome_line: 'Send messages, join channels.',
		install_count: 46,
	})
	const recCard = buildCard({
		item_kind: 'loop',
		catalog_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
		slug: 'churn-recovery-recommended',
		display_name: 'Churn Recovery loop',
		outcome_line: 'Recommended flavour of Churn Recovery.',
		install_count: 3,
		why_line: 'Sentinel is idle and PostHog is already connected',
	})
	return {
		bands: {
			recommended: [recCard],
			popular_loops: [loopCard],
			top_agents: [agentCard],
			most_installed_tools: [toolCard],
		},
		team_grid: [loopCard, agentCard, skillCard, toolCard],
		next_cursor: null,
		...overrides,
	}
}

describe('MarketplacePage (v3)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the top-bar tabs + By-team chip rail while the catalog is loading', () => {
		listMock.mockImplementation(() => new Promise(() => {}))
		render(<MarketplacePage />, { wrapper: TestWrapper })
		expect(screen.getByRole('heading', { name: 'Marketplace' })).toBeInTheDocument()
		// Featured is the default tab.
		expect(screen.getByRole('tab', { name: 'Featured', selected: true })).toBeInTheDocument()
		// The By-team chip rail renders All teams by default.
		expect(screen.getByRole('tablist', { name: 'Filter by team' })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: 'All teams' })).toBeInTheDocument()
	})

	it('renders skeleton cards under the Recommended band while the catalog is loading', () => {
		listMock.mockImplementation(() => new Promise(() => {}))
		const { container } = render(<MarketplacePage />, { wrapper: TestWrapper })
		expect(container.querySelectorAll('.mp-skel-card').length).toBeGreaterThan(0)
		expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
	})

	it('renders all five bands with cards + tab counts derived from the server response', async () => {
		listMock.mockResolvedValue(buildCatalog())
		render(<MarketplacePage />, { wrapper: TestWrapper })

		// Recommended band renders the WHY line pill from the seeded card.
		await waitFor(() =>
			expect(
				screen.getByText(/Sentinel is idle and PostHog is already connected/i),
			).toBeInTheDocument(),
		)
		// All five bands render, aria-labelled by band title.
		expect(screen.getByRole('region', { name: 'Recommended for you' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Popular loops' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Top agents' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Popular skills' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Most-installed tools' })).toBeInTheDocument()

		// popular_skills is derived from team_grid client-side — the skill card
		// only appears in team_grid on the wire, and the page still renders it.
		expect(screen.getByText('Plain English voice')).toBeInTheDocument()

		// Tab counts are derived from team_grid: 1 loop, 1 agent, 1 skill, 1 tool.
		expect(screen.getByRole('tab', { name: /Loops, 1 items/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /Agents, 1 items/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /Skills, 1 items/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /Tools, 1 items/ })).toBeInTheDocument()
	})

	it('calls the catalog endpoint with the workspace id and refetches with a team filter when a chip is clicked', async () => {
		listMock.mockResolvedValue(buildCatalog())
		render(<MarketplacePage />, { wrapper: TestWrapper })

		await waitFor(() => expect(listMock).toHaveBeenCalledWith('ws-1', { team: undefined }))

		const user = userEvent.setup()
		await user.click(screen.getByRole('tab', { name: 'Customer' }))
		await waitFor(() => expect(listMock).toHaveBeenCalledWith('ws-1', { team: 'customer' }))
	})

	it('renders the band-level error state when the catalog request fails', async () => {
		listMock.mockRejectedValue(new Error('offline'))
		render(<MarketplacePage />, { wrapper: TestWrapper })
		await waitFor(() => expect(screen.getByText(/Couldn't load the catalog/i)).toBeInTheDocument())
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
	})

	it('renders the Recommended empty state when no cards match', async () => {
		listMock.mockResolvedValue(
			buildCatalog({
				bands: {
					recommended: [],
					popular_loops: [],
					top_agents: [],
					most_installed_tools: [],
				},
				team_grid: [],
			}),
		)
		render(<MarketplacePage />, { wrapper: TestWrapper })
		await waitFor(() => expect(screen.getByText(/Nothing to recommend yet/i)).toBeInTheDocument())
	})

	it('opens the install modal on Install and flips the card to installed via optimistic cache write', async () => {
		listMock.mockResolvedValue(buildCatalog())
		installMock.mockResolvedValue({
			id: 'inst-1234-5678-9012-345678901234',
			workspace_id: 'ws-1',
			item_kind: 'agent',
			catalog_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
			catalog_slug: 'compass',
			installed_loop_id: null,
			actor_id: 'act-1',
			workspace_skill_id: null,
			mcp_installation_id: null,
			trigger_ids: [],
			source: 'marketplace',
			installed_by_actor_id: 'user-1',
			installed_at: new Date().toISOString(),
			uninstalled_at: null,
		})
		render(<MarketplacePage />, { wrapper: TestWrapper })

		await waitFor(() => expect(screen.getByText('Compass')).toBeInTheDocument())

		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Install Compass' }))
		expect(screen.getByRole('dialog', { name: /Install Compass/ })).toBeInTheDocument()

		// Kick off the install; the modal moves through installing → success and
		// the underlying card flips to the Installed chip via the optimistic
		// cache write in useInstallMarketplaceItem.onSuccess.
		await user.click(screen.getByRole('button', { name: /Install to \w+/ }))
		await waitFor(() =>
			expect(installMock).toHaveBeenCalledWith('ws-1', {
				item_kind: 'agent',
				catalog_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
			}),
		)
		await waitFor(() => expect(screen.getByLabelText('Compass, installed')).toBeInTheDocument())
	})
})
