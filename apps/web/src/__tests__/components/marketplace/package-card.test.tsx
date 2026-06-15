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
import type { CatalogPackageSummary, InstalledPackageRow } from '@/lib/api'
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
})
