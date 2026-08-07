import { render, screen } from '@testing-library/react'
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

import { MarketplaceItemDetail } from '@/components/marketplace/marketplace-item-detail'
import type { MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { TestWrapper } from '../../setup'

const workspaceId = 'ws-1'

function parentLoop(overrides: Partial<MarketplaceLoopSummary> = {}): MarketplaceLoopSummary {
	return {
		id: 'loop-1',
		name: 'Customer Continuous Discovery',
		slug: 'customer-continuous-discovery',
		description: '',
		version: '1.0.0',
		use_case: null,
		item_types: ['actor'],
		created_at: null,
		updated_at: null,
		...overrides,
	}
}

function actorItem(overrides: Partial<MarketplaceLoopItem> = {}): MarketplaceLoopItem {
	return {
		id: 'item-1',
		loop_id: 'loop-1',
		item_type: 'actor',
		source_item_id: 'item-1',
		item_snapshot: {
			name: 'Relay',
			description: 'Handles handoffs.',
			llm_provider: 'anthropic',
			system_prompt: 'You triage customer feedback.',
		},
		created_at: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('MarketplaceItemDetail', () => {
	it('renders the item name, description, and kind label', () => {
		render(
			<MarketplaceItemDetail
				workspaceId={workspaceId}
				item={actorItem()}
				parentLoop={parentLoop()}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('heading', { name: 'Relay' })).toBeInTheDocument()
		expect(screen.getByText('Handles handoffs.')).toBeInTheDocument()
		expect(screen.getByText('Agent')).toBeInTheDocument()
	})

	it('renders type-specific snapshot details read-only', () => {
		render(
			<MarketplaceItemDetail
				workspaceId={workspaceId}
				item={actorItem()}
				parentLoop={parentLoop()}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('LLM provider')).toBeInTheDocument()
		expect(screen.getByText('anthropic')).toBeInTheDocument()
		expect(screen.getByText('System prompt')).toBeInTheDocument()
		// Read-only — no textbox/textarea for the snapshot fields.
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('links back to the parent loop', () => {
		render(
			<MarketplaceItemDetail
				workspaceId={workspaceId}
				item={actorItem()}
				parentLoop={parentLoop()}
			/>,
			{ wrapper: TestWrapper },
		)
		const link = screen.getByText(/Part of Customer Continuous Discovery/)
		expect(link.closest('a')).toHaveAttribute('href', '/$workspaceId/marketplace/$loopId')
	})

	it('shows the Install CTA when not installed', () => {
		render(
			<MarketplaceItemDetail
				workspaceId={workspaceId}
				item={actorItem()}
				parentLoop={parentLoop()}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /install/i })).toBeInTheDocument()
	})
})
