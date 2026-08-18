import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedLoops: {
			list: vi.fn(),
			install: vi.fn(),
			fork: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { MarketplaceLoopCard } from '@/components/marketplace/marketplace-loop-card'
import type { InstalledLoopRow, MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { TestWrapper } from '../../setup'

const workspaceId = 'ws-1'

function loop(overrides: Partial<MarketplaceLoopSummary> = {}): MarketplaceLoopSummary {
	return {
		id: 'loop-1',
		name: 'Customer Continuous Discovery',
		slug: 'customer-continuous-discovery',
		description: 'Turns feedback into clustered insights.',
		version: '1.0.0',
		use_case: 'Discovery',
		item_types: ['actor', 'trigger'],
		created_at: null,
		updated_at: null,
		...overrides,
	}
}

function install(overrides: Partial<InstalledLoopRow> = {}): InstalledLoopRow {
	return {
		id: 'inst-1',
		workspaceId,
		sourceLoopId: 'loop-1',
		objectId: 'obj-1',
		loopName: 'Customer Continuous Discovery',
		installedVersion: '1.0.0',
		isLocked: true,
		forkedAt: null,
		installedAt: null,
		updatedAt: null,
		availableVersion: '1.0.0',
		hasUpdate: false,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('MarketplaceLoopCard', () => {
	it('shows the Install CTA and the kind label when not installed', () => {
		render(<MarketplaceLoopCard workspaceId={workspaceId} loop={loop()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('button', { name: /^install$/i })).toBeInTheDocument()
		// Multi-type loops read as a bundle; the label is colour-coded per kind.
		expect(screen.getByText('Loop')).toBeInTheDocument()
		expect(screen.queryByText(/Managed/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Forked from/)).not.toBeInTheDocument()
		expect(screen.queryByText('Installed')).not.toBeInTheDocument()
	})

	it('shows the Managed badge, an Installed marker and Manage when locked', () => {
		render(<MarketplaceLoopCard workspaceId={workspaceId} loop={loop()} install={install()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText(/Managed · v1.0.0/)).toBeInTheDocument()
		expect(screen.getByText('Installed')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute(
			'href',
			'/$workspaceId/loops/$loopId',
		)
		// Fork and Remove live in the detail page's overflow menu, not on the card.
		expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument()
	})

	it('offers Remove instead of Manage when the install has no provisioned loop', () => {
		render(
			<MarketplaceLoopCard
				workspaceId={workspaceId}
				loop={loop()}
				install={install({ objectId: null })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByRole('link', { name: 'Manage' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
	})

	it('renders the amber update banner when a locked install trails the marketplace version', () => {
		render(
			<MarketplaceLoopCard
				workspaceId={workspaceId}
				loop={loop({ version: '1.1.0' })}
				install={install({ installedVersion: '1.0.0', availableVersion: '1.1.0', hasUpdate: true })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Update to v1\.1\.0 available/)).toBeInTheDocument()
	})

	it('shows Forked-from badge and no Fork button when forked', () => {
		render(
			<MarketplaceLoopCard
				workspaceId={workspaceId}
				loop={loop()}
				install={install({ isLocked: false, forkedAt: '2026-06-12T00:00:00.000Z' })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Forked from v1\.0\.0/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument()
	})

	describe('composition chip row', () => {
		function item(overrides: {
			id: string
			itemType: MarketplaceLoopItem['item_type']
			name: string
		}): MarketplaceLoopItem {
			return {
				id: overrides.id,
				loop_id: 'loop-1',
				item_type: overrides.itemType,
				source_item_id: overrides.id,
				item_snapshot: { name: overrides.name },
				created_at: null,
			}
		}

		it('renders a count chip for agents and triggers on a bundle with more than one of each', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor', 'trigger'] })}
					items={[
						item({ id: 'a1', itemType: 'actor', name: 'Relay' }),
						item({ id: 'a2', itemType: 'actor', name: 'Compass' }),
						item({ id: 't1', itemType: 'trigger', name: 'On Slack message' }),
						item({ id: 't2', itemType: 'trigger', name: 'Fri 5 PM digest' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			const row = screen.getByLabelText('Bundle composition')
			expect(row).toHaveTextContent('2 agents')
			expect(row).toHaveTextContent('2 triggers')
			// Single count chip for each, not one per agent/trigger name
			expect(row).not.toHaveTextContent('Relay')
			expect(row).not.toHaveTextContent('Compass')
			expect(row).not.toHaveTextContent('On Slack message')
			expect(row).not.toHaveTextContent('Fri 5 PM digest')
		})

		it('renders a single named chip when there is exactly one agent', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor', 'trigger'] })}
					items={[
						item({ id: 'a1', itemType: 'actor', name: 'Relay' }),
						item({ id: 't1', itemType: 'trigger', name: 'On new signup' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			const row = screen.getByLabelText('Bundle composition')
			expect(row).toHaveTextContent('Relay')
			expect(row).not.toHaveTextContent('1 agent')
		})

		it('renders one chip per integration on a bundle', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor', 'integration'] })}
					items={[
						item({ id: 'a1', itemType: 'actor', name: 'Compass' }),
						item({ id: 'i1', itemType: 'integration', name: 'Intercom' }),
						item({ id: 'i2', itemType: 'integration', name: 'Slack' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			const row = screen.getByLabelText('Bundle composition')
			expect(row).toHaveTextContent('Intercom')
			expect(row).toHaveTextContent('Slack')
		})

		it('uses singular label when exactly one trigger', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor', 'trigger'] })}
					items={[
						item({ id: 'a1', itemType: 'actor', name: 'Compass' }),
						item({ id: 't1', itemType: 'trigger', name: 'On new signup' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.getByLabelText('Bundle composition')).toHaveTextContent('1 trigger')
		})

		it('does not render the chip row when the loop has fewer than two component types', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor'] })}
					items={[item({ id: 'a1', itemType: 'actor', name: 'Relay' })]}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByLabelText('Bundle composition')).not.toBeInTheDocument()
		})

		it('falls back to the kind chip row when items have not loaded yet', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor', 'trigger'] })}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByLabelText('Bundle composition')).not.toBeInTheDocument()
			expect(screen.getByLabelText('Card composition')).toBeInTheDocument()
		})

		it('names the kinds it installs on a single-type card, never the raw item type', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['skill'] })}
					items={[item({ id: 's1', itemType: 'skill', name: 'Cluster feedback' })]}
				/>,
				{ wrapper: TestWrapper },
			)
			// Mockup 2593: every card carries a chip row. A single-type card has
			// no bundle to describe, so it names its kind — "Skill", not "skill".
			const row = screen.getByLabelText('Card composition')
			expect(row).toHaveTextContent('Skill')
			expect(screen.queryByText('skill')).not.toBeInTheDocument()
		})
	})
})
