import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedLoops: {
			list: vi.fn(),
			install: vi.fn(),
			fork: vi.fn(),
			uninstall: vi.fn(),
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
import { api } from '@/lib/api'
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

function installRow(overrides: Partial<InstalledLoopRow> = {}): InstalledLoopRow {
	return {
		id: 'inst-1',
		workspaceId: 'ws-1',
		sourceLoopId: 'loop-1',
		objectId: null,
		loopName: 'Customer Continuous Discovery',
		installedVersion: '1.0.0',
		isLocked: false,
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

describe('MarketplaceLoopDetail', () => {
	it('tags an install started from the detail surface with source "detail"', async () => {
		render(<MarketplaceLoopDetail workspaceId={workspaceId} loop={loop()} items={[]} />, {
			wrapper: TestWrapper,
		})
		fireEvent.click(screen.getByRole('button', { name: /install loop/i }))
		await screen.findByRole('button', { name: /install loop/i })
		expect(api.installedLoops.install).toHaveBeenCalledWith('ws-1', 'loop-1', 'detail')
	})

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

	it('renders the breadcrumb back to the catalog', () => {
		render(<MarketplaceLoopDetail workspaceId={workspaceId} loop={loop()} items={[]} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('link', { name: 'Marketplace' })).toBeInTheDocument()
		expect(screen.getByText('Loops')).toBeInTheDocument()
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

	it('renders "The flow" from real trigger + actor snapshots', () => {
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
		expect(screen.getByText('The flow')).toBeInTheDocument()
		// "Relay" appears once in "The flow" and once in "What it brings".
		expect(screen.getAllByText('Relay')).toHaveLength(2)
		expect(screen.getByText('When signal is created')).toBeInTheDocument()
		expect(screen.getByText('Acknowledge the customer in their own words.')).toBeInTheDocument()
	})

	it('puts an "asks you" pill on a step whose agent prompt gates on the operator', () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[
					item({
						id: 'a1',
						item_type: 'actor',
						source_item_id: 'actor-source-1',
						item_snapshot: {
							name: 'Relay',
							type: 'agent',
							systemPrompt:
								'You post drafts but never auto-apply; you require explicit user signoff.',
						},
					}),
					item({
						id: 't1',
						item_type: 'trigger',
						source_item_id: 'trigger-source-1',
						item_snapshot: {
							name: 'On new feedback',
							type: 'event',
							config: { entity_type: 'signal', action: 'created' },
							actionPrompt: 'Acknowledge the customer.',
							targetActorId: 'actor-source-1',
						},
					}),
				]}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('asks you · your explicit sign-off')).toBeInTheDocument()
	})

	it('lists gated steps under "What it will ask you for" with the ask and why', () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[
					item({
						id: 'a1',
						item_type: 'actor',
						source_item_id: 'actor-source-1',
						item_snapshot: {
							name: 'Relay',
							type: 'agent',
							systemPrompt: 'When you hit a risk, asks you to confirm before escalating.',
						},
					}),
					item({
						id: 't1',
						item_type: 'trigger',
						source_item_id: 'trigger-source-1',
						item_snapshot: {
							name: 'On new feedback',
							type: 'event',
							config: { entity_type: 'signal', action: 'created' },
							actionPrompt: 'Acknowledge the customer.',
							targetActorId: 'actor-source-1',
						},
					}),
				]}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('What it will ask you for')).toBeInTheDocument()
		expect(screen.getByText('a decision from you')).toBeInTheDocument()
		expect(screen.getByText(/asks you to confirm before escalating/)).toBeInTheDocument()
	})

	it('does not render "The flow" when the loop has no triggers', () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[item({ id: 'a1', item_type: 'actor', item_snapshot: { name: 'Relay' } })]}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByText('The flow')).not.toBeInTheDocument()
	})

	it('renders "How it runs" from the loop version', () => {
		render(<MarketplaceLoopDetail workspaceId={workspaceId} loop={loop()} items={[]} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('How it runs')).toBeInTheDocument()
		expect(screen.getByText('Version')).toBeInTheDocument()
		expect(screen.getByText('1.0.0')).toBeInTheDocument()
		expect(screen.getByText('0 steps')).toBeInTheDocument()
	})

	it('shows Remove in the overflow menu and uninstalls without a confirmation dialog', async () => {
		render(
			<MarketplaceLoopDetail
				workspaceId={workspaceId}
				loop={loop()}
				items={[]}
				install={installRow()}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByRole('button', { name: /install loop/i })).not.toBeInTheDocument()
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Loop actions' }))
		const remove = await screen.findByText('Remove from workspace')
		expect(remove).toBeInTheDocument()
		await user.click(remove)
		expect(api.installedLoops.uninstall).toHaveBeenCalledWith('ws-1', 'inst-1', false)
	})
})
