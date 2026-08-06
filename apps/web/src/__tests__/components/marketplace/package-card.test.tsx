import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedPackages: {
			list: vi.fn(),
			install: vi.fn(),
			fork: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { PackageCard } from '@/components/marketplace/package-card'
import type { CatalogPackageItem, CatalogPackageSummary, InstalledPackageRow } from '@/lib/api'
import { TestWrapper } from '../../setup'

const workspaceId = 'ws-1'

function pkg(overrides: Partial<CatalogPackageSummary> = {}): CatalogPackageSummary {
	return {
		id: 'pkg-1',
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

function item(
	overrides: Partial<CatalogPackageItem> & {
		id: string
		itemType: CatalogPackageItem['item_type']
		name: string
	},
): CatalogPackageItem {
	return {
		id: overrides.id,
		package_id: 'pkg-1',
		item_type: overrides.itemType,
		source_item_id: overrides.id,
		item_snapshot: { name: overrides.name, description: null },
		created_at: null,
	}
}

function install(overrides: Partial<InstalledPackageRow> = {}): InstalledPackageRow {
	return {
		id: 'inst-1',
		workspaceId,
		sourcePackageId: 'pkg-1',
		packageName: 'Customer Continuous Discovery',
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

describe('PackageCard', () => {
	it('shows Install package CTA when not installed', () => {
		render(<PackageCard workspaceId={workspaceId} pkg={pkg()} />, { wrapper: TestWrapper })
		expect(screen.getByRole('button', { name: /install package/i })).toBeInTheDocument()
		expect(screen.queryByText(/Managed/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Forked from/)).not.toBeInTheDocument()
	})

	it('shows Managed badge and Fork button when locked', () => {
		render(<PackageCard workspaceId={workspaceId} pkg={pkg()} install={install()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText(/Managed · v1.0.0/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /install package/i })).not.toBeInTheDocument()
	})

	it('renders the amber update banner when a locked install trails the catalog version', () => {
		render(
			<PackageCard
				workspaceId={workspaceId}
				pkg={pkg({ version: '1.1.0' })}
				install={install({ installedVersion: '1.0.0', availableVersion: '1.1.0', hasUpdate: true })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Update to v1\.1\.0 available/)).toBeInTheDocument()
	})

	it('shows Forked-from badge and no Fork button when forked', () => {
		render(
			<PackageCard
				workspaceId={workspaceId}
				pkg={pkg()}
				install={install({ isLocked: false, forkedAt: '2026-06-12T00:00:00.000Z' })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Forked from v1\.0\.0/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument()
	})

	it('opens the fork confirmation dialog when Fork is clicked', async () => {
		render(<PackageCard workspaceId={workspaceId} pkg={pkg()} install={install()} />, {
			wrapper: TestWrapper,
		})
		await userEvent.click(screen.getByRole('button', { name: /fork/i }))
		expect(screen.getByText(/Fork this package\?/)).toBeInTheDocument()
		expect(screen.getByText(/Forking can't be undone\./)).toBeInTheDocument()
	})

	it('names the pending update in the fork dialog when one is available', async () => {
		render(
			<PackageCard
				workspaceId={workspaceId}
				pkg={pkg({ version: '1.1.0' })}
				install={install({ installedVersion: '1.0.0', availableVersion: '1.1.0', hasUpdate: true })}
			/>,
			{ wrapper: TestWrapper },
		)
		await userEvent.click(screen.getByRole('button', { name: /fork/i }))
		expect(screen.getByText(/v1\.1\.0 is ready to install/)).toBeInTheDocument()
	})

	describe('composition chip row', () => {
		it('does not render on single-type packages even when items are supplied', () => {
			render(
				<PackageCard
					workspaceId={workspaceId}
					pkg={pkg({ item_types: ['actor'] })}
					items={[item({ id: 'i-1', itemType: 'actor', name: 'Relay Agent' })]}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByLabelText('Package composition')).not.toBeInTheDocument()
		})

		it('does not render on multi-type packages when no items are supplied', () => {
			render(
				<PackageCard workspaceId={workspaceId} pkg={pkg({ item_types: ['actor', 'trigger'] })} />,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByLabelText('Package composition')).not.toBeInTheDocument()
		})

		it('renders one chip per actor with initial + short name and full name as accessible label', () => {
			render(
				<PackageCard
					workspaceId={workspaceId}
					pkg={pkg({ item_types: ['actor', 'trigger'] })}
					items={[
						item({ id: 'a-1', itemType: 'actor', name: 'Relay Support Agent' }),
						item({ id: 'a-2', itemType: 'actor', name: 'Compass Insights Agent' }),
						item({ id: 't-1', itemType: 'trigger', name: 'Nightly digest' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			const row = screen.getByLabelText('Package composition')
			expect(row).toBeInTheDocument()
			// The short name is the first word of the full item name.
			expect(screen.getByRole('button', { name: 'Relay Support Agent' })).toHaveTextContent(
				/^R\s*Relay$/,
			)
			expect(screen.getByRole('button', { name: 'Compass Insights Agent' })).toHaveTextContent(
				/^C\s*Compass$/,
			)
		})

		it('renders a single count chip for triggers, not one chip per trigger', () => {
			render(
				<PackageCard
					workspaceId={workspaceId}
					pkg={pkg({ item_types: ['actor', 'trigger'] })}
					items={[
						item({ id: 'a-1', itemType: 'actor', name: 'Relay' }),
						item({ id: 't-1', itemType: 'trigger', name: 'Nightly digest' }),
						item({ id: 't-2', itemType: 'trigger', name: 'Weekly rollup' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			const row = screen.getByLabelText('Package composition')
			// Two trigger items → one count chip that says "2 triggers".
			expect(row).toHaveTextContent(/2 triggers/)
			// The trigger names live in the tooltip trigger's aria-label so touch
			// users can read them via assistive tech even without opening the tip.
			const triggerChip = screen.getByRole('button', {
				name: /2 triggers: Nightly digest, Weekly rollup/,
			})
			expect(triggerChip).toBeInTheDocument()
		})

		it('singularises the trigger count chip when only one trigger is present', () => {
			render(
				<PackageCard
					workspaceId={workspaceId}
					pkg={pkg({ item_types: ['actor', 'trigger'] })}
					items={[
						item({ id: 'a-1', itemType: 'actor', name: 'Relay' }),
						item({ id: 't-1', itemType: 'trigger', name: 'Nightly digest' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.getByLabelText('Package composition')).toHaveTextContent(/1 trigger(?!s)/)
		})

		it('renders one chip per integration with the full name as accessible label', () => {
			render(
				<PackageCard
					workspaceId={workspaceId}
					pkg={pkg({ item_types: ['actor', 'integration'] })}
					items={[
						item({ id: 'a-1', itemType: 'actor', name: 'Relay' }),
						item({ id: 'i-1', itemType: 'integration', name: 'Intercom' }),
						item({ id: 'i-2', itemType: 'integration', name: 'Slack' }),
					]}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.getByRole('button', { name: 'Intercom' })).toHaveTextContent(/^I\s*Intercom$/)
			expect(screen.getByRole('button', { name: 'Slack' })).toHaveTextContent(/^S\s*Slack$/)
		})
	})
})
