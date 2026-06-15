import { PackageGrid } from '@/components/catalog/package-grid'
import type { CatalogPackageSummary } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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

describe('PackageGrid', () => {
	it('renders a section per item type the catalog actually has', () => {
		const packages = [
			buildPackage({ id: 'a', name: 'Agent Only', item_types: ['actor'] }),
			buildPackage({ id: 't', name: 'Trigger Only', item_types: ['trigger'] }),
		]
		render(<PackageGrid packages={packages} />)
		expect(screen.getByRole('region', { name: 'Agents' })).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Triggers' })).toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Skills' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Integrations' })).not.toBeInTheDocument()
	})

	it('lists a multi-type package in every matching section', () => {
		const pkg = buildPackage({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		render(<PackageGrid packages={[pkg]} />)
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('Multi-element bundle')
		expect(screen.getByRole('region', { name: 'Triggers' })).toHaveTextContent(
			'Multi-element bundle',
		)
	})

	it('renders only the active type section when activeType is set', () => {
		const pkg = buildPackage({
			id: 'bundle',
			name: 'Multi-element bundle',
			item_types: ['actor', 'trigger'],
		})
		render(<PackageGrid packages={[pkg]} activeType="actor" />)
		expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('Multi-element bundle')
		expect(screen.queryByRole('region', { name: 'Triggers' })).not.toBeInTheDocument()
	})

	it('renders nothing when the package list is empty', () => {
		const { container } = render(<PackageGrid packages={[]} />)
		expect(container.firstChild).toBeNull()
	})
})
