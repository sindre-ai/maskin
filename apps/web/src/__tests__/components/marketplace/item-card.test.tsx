import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		catalogItems: {
			install: vi.fn(),
			uninstall: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { ItemCard } from '@/components/marketplace/item-card'
import type { CatalogPackageItem } from '@/lib/api'
import { TestWrapper } from '../../setup'

const workspaceId = 'ws-1'

function catalogItem(overrides: Partial<CatalogPackageItem> = {}): CatalogPackageItem {
	return {
		id: 'item-1',
		package_id: 'pkg-1',
		item_type: 'actor',
		source_item_id: 'src-1',
		item_snapshot: {
			name: 'Sample Agent',
			description: 'A sample catalog agent used for testing.',
		},
		created_at: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('ItemCard', () => {
	it('renders the Install button when no install is present', () => {
		render(<ItemCard workspaceId={workspaceId} item={catalogItem()} />, { wrapper: TestWrapper })
		expect(screen.getByRole('button', { name: /^install$/i })).toBeInTheDocument()
	})

	it('Install button carries the pointer-coarse:min-h-11 tap-target floor', () => {
		render(<ItemCard workspaceId={workspaceId} item={catalogItem()} />, { wrapper: TestWrapper })
		const button = screen.getByRole('button', { name: /^install$/i })
		expect(button.className).toContain('pointer-coarse:min-h-11')
	})
})
