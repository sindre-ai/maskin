import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { LoopGrid } from '@/components/marketplace/loop-grid'
import type { MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { TestWrapper } from '../../setup'

function buildLoop(
	overrides: Partial<MarketplaceLoopSummary> & { id: string; name: string },
): MarketplaceLoopSummary {
	return {
		slug: overrides.id,
		description: '',
		version: '1.0.0',
		use_case: null,
		item_types: ['actor'],
		created_at: null,
		updated_at: null,
		...overrides,
	}
}

function buildItem(
	overrides: Partial<MarketplaceLoopItem> & {
		id: string
		loopId: string
		itemType: MarketplaceLoopItem['item_type']
		name: string
	},
): MarketplaceLoopItem {
	return {
		id: overrides.id,
		loop_id: overrides.loopId,
		item_type: overrides.itemType,
		source_item_id: overrides.id,
		item_snapshot: { name: overrides.name, description: null },
		created_at: null,
	}
}

describe('LoopGrid', () => {
	it('renders single-type loops in their matching typed section', () => {
		const loops = [
			buildLoop({ id: 'a', name: 'Agent Only', item_types: ['actor'] }),
			buildLoop({ id: 't', name: 'Trigger Only', item_types: ['trigger'] }),
		]
		render(<LoopGrid loops={loops} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByRole('region', { name: 'Agents' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Triggers' })).toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Skills' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Integrations' })).not.toBeInTheDocument()
	})

	it('places a multi-type loop in the Loops section, not in typed sections', () => {
		const loop = buildLoop({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		render(<LoopGrid loops={[loop]} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent('Multi-element bundle')
		expect(screen.queryByRole('region', { name: 'Agents' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('shows individual items from a multi-type loop in their typed sections', () => {
		const loop = buildLoop({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		const items = [
			buildItem({ id: 'item-1', loopId: 'bundle', itemType: 'actor', name: 'My Agent' }),
			buildItem({ id: 'item-2', loopId: 'bundle', itemType: 'trigger', name: 'My Trigger' }),
		]
		render(<LoopGrid loops={[loop]} items={items} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent('Multi-element bundle')
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('My Agent')
		expect(screen.getByRole('region', { name: 'Triggers' })).toHaveTextContent('My Trigger')
		// The bundle itself should not appear in typed sections
		expect(screen.getByRole('region', { name: 'Agents' })).not.toHaveTextContent(
			'Multi-element bundle',
		)
		expect(screen.getByRole('region', { name: 'Triggers' })).not.toHaveTextContent(
			'Multi-element bundle',
		)
	})

	it('renders only the Agents section when typeFilter is actor', () => {
		const loop = buildLoop({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		const items = [
			buildItem({ id: 'item-1', loopId: 'bundle', itemType: 'actor', name: 'My Agent' }),
		]
		render(<LoopGrid loops={[loop]} items={items} typeFilter="actor" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('My Agent')
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Loops' })).not.toBeInTheDocument()
	})

	it('renders only the Loops section when typeFilter is loops', () => {
		const loop = buildLoop({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		render(<LoopGrid loops={[loop]} typeFilter="loops" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent('Multi-element bundle')
		expect(screen.queryByRole('region', { name: 'Agents' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('renders nothing when the loop list is empty', () => {
		const { container } = render(<LoopGrid loops={[]} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(container.firstChild).toBeNull()
	})
})
