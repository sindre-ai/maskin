import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedLoops: {
			list: vi.fn(),
			install: vi.fn(),
			fork: vi.fn(),
		},
		marketplaceItems: {
			install: vi.fn(),
			installed: vi.fn(),
			uninstall: vi.fn(),
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

import { MarketplaceLoopDetail } from '@/components/marketplace/marketplace-loop-detail'
import type { MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
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

function item(overrides: Partial<MarketplaceLoopItem> = {}): MarketplaceLoopItem {
	return {
		id: 'item-1',
		loop_id: 'loop-1',
		item_type: 'actor',
		source_item_id: 'item-1',
		item_snapshot: { name: 'Relay', description: 'Handles handoffs.' },
		created_at: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('MarketplaceLoopDetail', () => {
	it('renders the loop name, description, and Install CTA when not installed', () => {
		render(<MarketplaceLoopDetail workspaceId={workspaceId} loop={loop()} items={[]} />, {
			wrapper: TestWrapper,
		})
		expect(
			screen.getByRole('heading', { name: 'Customer Continuous Discovery' }),
		).toBeInTheDocument()
		expect(screen.getByText('Turns feedback into clustered insights.')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /install loop/i })).toBeInTheDocument()
	})

	it('lists each item under "What it brings", linking to its detail page', () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[
					item({ id: 'a1', item_type: 'actor', item_snapshot: { name: 'Relay' } }),
					item({ id: 't1', item_type: 'trigger', item_snapshot: { name: 'On new signup' } }),
				]}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('What it brings')).toBeInTheDocument()
		const relayLink = screen.getByText('Relay').closest('a')
		expect(relayLink).toHaveAttribute('href', '/$workspaceId/marketplace/$loopId/$itemId')
		expect(screen.getByText('On new signup')).toBeInTheDocument()
	})

	it('does not render "What it brings" when the loop has no items', () => {
		render(<MarketplaceLoopDetail workspaceId={workspaceId} loop={loop()} items={[]} />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByText('What it brings')).not.toBeInTheDocument()
	})

	it('renders "How it works" from real trigger + actor snapshots', () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[
					item({
						id: 'a1',
						item_type: 'actor',
						source_item_id: 'actor-source-1',
						item_snapshot: { name: 'Relay', type: 'agent' },
					}),
					item({
						id: 't1',
						item_type: 'trigger',
						source_item_id: 'trigger-source-1',
						item_snapshot: {
							name: 'On new feedback',
							type: 'event',
							config: { entity_type: 'signal', action: 'created' },
							actionPrompt: 'Acknowledge the customer in their own words.',
							targetActorId: 'actor-source-1',
						},
					}),
				]}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('How it works')).toBeInTheDocument()
		// "Relay" appears once in "How it works" and once in "What it brings".
		expect(screen.getAllByText('Relay')).toHaveLength(2)
		expect(screen.getByText('When signal is created')).toBeInTheDocument()
		expect(screen.getByText('Acknowledge the customer in their own words.')).toBeInTheDocument()
	})

	it('does not render "How it works" when the loop has no triggers', () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[item({ id: 'a1', item_type: 'actor', item_snapshot: { name: 'Relay' } })]}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByText('How it works')).not.toBeInTheDocument()
	})
})
