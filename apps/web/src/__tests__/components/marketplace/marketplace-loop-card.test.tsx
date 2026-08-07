import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
	it('shows Install loop CTA when not installed', () => {
		render(<MarketplaceLoopCard workspaceId={workspaceId} loop={loop()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('button', { name: /install loop/i })).toBeInTheDocument()
		expect(screen.queryByText(/Managed/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Forked from/)).not.toBeInTheDocument()
	})

	it('shows Managed badge and Fork button when locked', () => {
		render(<MarketplaceLoopCard workspaceId={workspaceId} loop={loop()} install={install()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText(/Managed · v1.0.0/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /install loop/i })).not.toBeInTheDocument()
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

	it('opens the fork confirmation dialog when Fork is clicked', async () => {
		render(<MarketplaceLoopCard workspaceId={workspaceId} loop={loop()} install={install()} />, {
			wrapper: TestWrapper,
		})
		await userEvent.click(screen.getByRole('button', { name: /fork/i }))
		expect(screen.getByText(/Fork this loop\?/)).toBeInTheDocument()
		expect(screen.getByText(/Forking can't be undone\./)).toBeInTheDocument()
	})

	it('names the pending update in the fork dialog when one is available', async () => {
		render(
			<MarketplaceLoopCard
				workspaceId={workspaceId}
				loop={loop({ version: '1.1.0' })}
				install={install({ installedVersion: '1.0.0', availableVersion: '1.1.0', hasUpdate: true })}
			/>,
			{ wrapper: TestWrapper },
		)
		await userEvent.click(screen.getByRole('button', { name: /fork/i }))
		expect(screen.getByText(/v1\.1\.0 is ready to install/)).toBeInTheDocument()
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

		it('renders one chip per actor and one count chip for triggers on a bundle', () => {
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
			expect(row).toHaveTextContent('Relay')
			expect(row).toHaveTextContent('Compass')
			expect(row).toHaveTextContent('2 triggers')
			// Single count chip for triggers, not one per trigger name
			expect(row).not.toHaveTextContent('On Slack message')
			expect(row).not.toHaveTextContent('Fri 5 PM digest')
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

		it('falls back to the type-badge row when items have not loaded yet', () => {
			render(
				<MarketplaceLoopCard
					workspaceId={workspaceId}
					loop={loop({ item_types: ['actor', 'trigger'] })}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByLabelText('Bundle composition')).not.toBeInTheDocument()
		})
	})
})
