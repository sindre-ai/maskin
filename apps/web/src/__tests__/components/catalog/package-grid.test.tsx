import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { PackageGrid } from '@/components/catalog/package-grid'
import type { CatalogPackageItem, CatalogPackageSummary } from '@/lib/api'
import { TestWrapper } from '../../setup'

function buildPackage(
	overrides: Partial<CatalogPackageSummary> & { id: string; name: string },
): CatalogPackageSummary {
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
	overrides: Partial<CatalogPackageItem> & {
		id: string
		packageId: string
		itemType: CatalogPackageItem['item_type']
		name: string
	},
): CatalogPackageItem {
	return {
		id: overrides.id,
		package_id: overrides.packageId,
		item_type: overrides.itemType,
		source_item_id: overrides.id,
		item_snapshot: { name: overrides.name, description: null },
		created_at: null,
	}
}

describe('PackageGrid', () => {
	it('renders single-type packages in their matching typed section', () => {
		const packages = [
			buildPackage({ id: 'a', name: 'Agent Only', item_types: ['actor'] }),
			buildPackage({ id: 't', name: 'Trigger Only', item_types: ['trigger'] }),
		]
		render(<PackageGrid packages={packages} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByRole('region', { name: 'Agents' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Triggers' })).toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Skills' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Integrations' })).not.toBeInTheDocument()
	})

	it('places a multi-type package in the Packages section, not in typed sections', () => {
		const pkg = buildPackage({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		render(<PackageGrid packages={[pkg]} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByRole('region', { name: 'Packages' })).toHaveTextContent(
			'Multi-element bundle',
		)
		expect(screen.queryByRole('region', { name: 'Agents' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('shows individual items from a multi-type package in their typed sections', () => {
		const pkg = buildPackage({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		const items = [
			buildItem({ id: 'item-1', packageId: 'bundle', itemType: 'actor', name: 'My Agent' }),
			buildItem({ id: 'item-2', packageId: 'bundle', itemType: 'trigger', name: 'My Trigger' }),
		]
		render(<PackageGrid packages={[pkg]} items={items} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('region', { name: 'Packages' })).toHaveTextContent(
			'Multi-element bundle',
		)
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
		const pkg = buildPackage({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		const items = [
			buildItem({ id: 'item-1', packageId: 'bundle', itemType: 'actor', name: 'My Agent' }),
		]
		render(<PackageGrid packages={[pkg]} items={items} typeFilter="actor" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('My Agent')
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Packages' })).not.toBeInTheDocument()
	})

	it('renders only the Packages section when typeFilter is packages', () => {
		const pkg = buildPackage({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		render(<PackageGrid packages={[pkg]} typeFilter="packages" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('region', { name: 'Packages' })).toHaveTextContent(
			'Multi-element bundle',
		)
		expect(screen.queryByRole('region', { name: 'Agents' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('renders nothing when the package list is empty', () => {
		const { container } = render(<PackageGrid packages={[]} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(container.firstChild).toBeNull()
	})

	it('renders the zero-results EmptyState when onResetFilters is provided and no packages match', () => {
		const onResetFilters = vi.fn()
		render(<PackageGrid packages={[]} workspaceId="ws-1" onResetFilters={onResetFilters} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('No matches for this filter combo')).toBeInTheDocument()
		const reset = screen.getByRole('button', { name: 'Reset filters' })
		expect(reset).toBeInTheDocument()
		// Tap-target floor: same additive pattern used across the bet.
		expect(reset.className).toContain('pointer-coarse:min-h-11')
		expect(reset.className).toContain('pointer-coarse:min-w-11')
	})

	it('fires onResetFilters when the Reset filters button is clicked', async () => {
		const onResetFilters = vi.fn()
		render(<PackageGrid packages={[]} workspaceId="ws-1" onResetFilters={onResetFilters} />, {
			wrapper: TestWrapper,
		})
		await userEvent.setup().click(screen.getByRole('button', { name: 'Reset filters' }))
		expect(onResetFilters).toHaveBeenCalledTimes(1)
	})

	it('also renders the EmptyState when packages exist but typeFilter narrows to zero sections', () => {
		const onResetFilters = vi.fn()
		const packages = [buildPackage({ id: 'a', name: 'Agent Only', item_types: ['actor'] })]
		render(
			<PackageGrid
				packages={packages}
				typeFilter="integration"
				workspaceId="ws-1"
				onResetFilters={onResetFilters}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('No matches for this filter combo')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument()
	})

	it('still renders null when no onResetFilters is passed (backward-compatible)', () => {
		const { container } = render(
			<PackageGrid packages={[]} workspaceId="ws-1" typeFilter="integration" />,
			{ wrapper: TestWrapper },
		)
		expect(container.firstChild).toBeNull()
	})
})
