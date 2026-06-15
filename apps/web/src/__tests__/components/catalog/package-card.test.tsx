import { PackageCard } from '@/components/catalog/package-card'
import type { CatalogPackageSummary } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

function buildPackage(overrides: Partial<CatalogPackageSummary> = {}): CatalogPackageSummary {
	return {
		id: 'pkg-1',
		name: 'Customer Continuous Discovery',
		slug: 'continuous-discovery',
		description: 'Feedback → insights → bets → comms',
		version: '1.4.0',
		use_case: 'Discovery',
		item_types: ['actor', 'trigger', 'skill'],
		created_at: null,
		updated_at: null,
		...overrides,
	}
}

describe('PackageCard', () => {
	it('renders name, description, version, and one chip per item_type', () => {
		render(<PackageCard pkg={buildPackage()} />)
		expect(screen.getByText('Customer Continuous Discovery')).toBeInTheDocument()
		expect(screen.getByText('Feedback → insights → bets → comms')).toBeInTheDocument()
		expect(screen.getByText('v1.4.0')).toBeInTheDocument()
		expect(screen.getByText('Agent')).toBeInTheDocument()
		expect(screen.getByText('Trigger')).toBeInTheDocument()
		expect(screen.getByText('Skill')).toBeInTheDocument()
	})

	it('shows the Install package CTA when not installed', () => {
		render(<PackageCard pkg={buildPackage()} />)
		const button = screen.getByRole('button', { name: /install package/i })
		expect(button).toBeEnabled()
	})

	it('shows the managed badge and disables the CTA when installed locked', () => {
		render(<PackageCard pkg={buildPackage()} installState={{ kind: 'managed', version: '1.4' }} />)
		expect(screen.getByText('Managed · v1.4')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /installed/i })).toBeDisabled()
	})

	it('shows the forked badge in the violet token combo', () => {
		render(<PackageCard pkg={buildPackage()} installState={{ kind: 'forked', version: '2.1' }} />)
		const badge = screen.getByText('Forked from v2.1')
		expect(badge).toBeInTheDocument()
		expect(badge.className).toMatch(/text-violet-800/)
	})

	it('calls onInstall when the CTA is clicked', async () => {
		const onInstall = vi.fn()
		render(<PackageCard pkg={buildPackage()} onInstall={onInstall} />)
		await userEvent.click(screen.getByRole('button', { name: /install package/i }))
		expect(onInstall).toHaveBeenCalledOnce()
		expect(onInstall.mock.calls[0]?.[0]?.id).toBe('pkg-1')
	})
})
