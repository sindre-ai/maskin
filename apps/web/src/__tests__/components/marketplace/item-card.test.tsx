import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		marketplaceItems: {
			install: vi.fn(),
			installed: vi.fn(),
			uninstall: vi.fn(),
		},
	},
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { ItemCard } from '@/components/marketplace/item-card'
import type { MarketplaceItemInstalledEntry, MarketplaceLoopItem } from '@/lib/api'
import { TestWrapper } from '../../setup'

const workspaceId = 'ws-1'

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

describe('ItemCard', () => {
	it('renders the item name/description and links to its detail page', () => {
		render(<ItemCard workspaceId={workspaceId} item={item()} />, { wrapper: TestWrapper })
		expect(screen.getByText('Relay')).toBeInTheDocument()
		expect(screen.getByText('Handles handoffs.')).toBeInTheDocument()
		const link = screen.getByRole('link', { name: /open relay/i })
		expect(link).toHaveAttribute('href', '/$workspaceId/marketplace/$loopId/$itemId')
	})

	it('shows the Install CTA when not installed', () => {
		render(<ItemCard workspaceId={workspaceId} item={item()} />, { wrapper: TestWrapper })
		expect(screen.getByRole('button', { name: /install/i })).toBeInTheDocument()
	})

	it('shows Installed + Remove when individually installed', () => {
		const installedEntity: MarketplaceItemInstalledEntry = {
			marketplace_item_id: 'item-1',
			entity_id: 'actor-1',
			entity_type: 'actor',
		}
		render(<ItemCard workspaceId={workspaceId} item={item()} installedEntity={installedEntity} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Installed')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
	})

	it('suppresses install controls when the parent loop is installed', () => {
		render(
			<ItemCard
				workspaceId={workspaceId}
				item={item()}
				install={{
					id: 'inst-1',
					workspaceId,
					sourceLoopId: 'loop-1',
					objectId: 'obj-1',
					loopName: 'Bundle',
					installedVersion: '1.0.0',
					isLocked: true,
					forkedAt: null,
					installedAt: null,
					updatedAt: null,
					availableVersion: '1.0.0',
					hasUpdate: false,
				}}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
		expect(screen.getByText(/Managed/)).toBeInTheDocument()
	})

	it('calls the install mutation with the item id when Install is clicked', async () => {
		const { api } = await import('@/lib/api')
		render(<ItemCard workspaceId={workspaceId} item={item()} />, { wrapper: TestWrapper })
		await userEvent.click(screen.getByRole('button', { name: /install/i }))
		expect(api.marketplaceItems.install).toHaveBeenCalledWith('item-1', workspaceId)
	})
})
