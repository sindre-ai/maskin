import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { FeaturedStrip } from '@/components/catalog/featured-strip'
import type { CatalogPackageSummary } from '@/lib/api'
import { TestWrapper } from '../../setup'

function buildPackage(
	overrides: Partial<CatalogPackageSummary> & { id: string; name: string },
): CatalogPackageSummary {
	return {
		slug: overrides.id,
		description: '',
		version: '1.0.0',
		use_case: null,
		is_featured: false,
		item_types: ['actor'],
		created_at: null,
		updated_at: null,
		...overrides,
	}
}

describe('FeaturedStrip', () => {
	it('renders only packages flagged is_featured', () => {
		const packages = [
			buildPackage({ id: 'a', name: 'Featured A', is_featured: true }),
			buildPackage({ id: 'b', name: 'Plain B', is_featured: false }),
			buildPackage({ id: 'c', name: 'Featured C', is_featured: true }),
		]
		render(<FeaturedStrip packages={packages} workspaceId="ws-1" />, { wrapper: TestWrapper })
		const region = screen.getByRole('region', { name: 'Featured' })
		expect(region).toHaveTextContent('Featured A')
		expect(region).toHaveTextContent('Featured C')
		expect(region).not.toHaveTextContent('Plain B')
	})

	it('renders nothing when no package is featured', () => {
		const { container } = render(
			<FeaturedStrip
				packages={[buildPackage({ id: 'a', name: 'A', is_featured: false })]}
				workspaceId="ws-1"
			/>,
			{ wrapper: TestWrapper },
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders nothing when the package list is empty', () => {
		const { container } = render(<FeaturedStrip packages={[]} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(container.firstChild).toBeNull()
	})

	it('uses a horizontally-scrollable container', () => {
		render(
			<FeaturedStrip
				packages={[buildPackage({ id: 'a', name: 'A', is_featured: true })]}
				workspaceId="ws-1"
			/>,
			{ wrapper: TestWrapper },
		)
		const region = screen.getByRole('region', { name: 'Featured' })
		const scroller = region.querySelector('div.overflow-x-auto')
		expect(scroller).not.toBeNull()
	})
})
