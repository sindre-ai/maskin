import { LowBalanceBanner } from '@/components/billing/low-balance-banner'
import type { BillingUsageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockUseBillingUsage =
	vi.fn<(workspaceId: string) => { data: BillingUsageResponse | undefined }>()

vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: (workspaceId: string) => mockUseBillingUsage(workspaceId),
}))

const trackLowBalanceBannerShown = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackLowBalanceBannerShown: (p: unknown) => trackLowBalanceBannerShown(p),
}))

// `<Link>` requires a RouterProvider; the banner only cares about the label
// and destination, both of which a plain <a> preserves.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
	}: {
		to: string
		params?: Record<string, string>
		children: ReactNode
	}) => {
		let href = to
		if (params) {
			for (const [k, v] of Object.entries(params)) href = href.replace(`$${k}`, v)
		}
		return <a href={href}>{children}</a>
	},
}))

function build(overrides: Partial<BillingUsageResponse> = {}): BillingUsageResponse {
	return {
		plan: 'pro',
		status: 'active',
		usd_cents_used: 0,
		hard_cap_usd_cents: 2_000,
		period_start: null,
		period_resets_in_ms: null,
		stripe_customer_id: null,
		stripe_subscription_id: null,
		credit_balance_cents: 185,
		sum_topups_last_30d_cents: 0,
		linkedin_identity_addon: null,
		...overrides,
	}
}

beforeEach(() => {
	mockUseBillingUsage.mockReset()
	trackLowBalanceBannerShown.mockReset()
})

afterEach(() => {
	vi.clearAllMocks()
})

describe('LowBalanceBanner', () => {
	it('renders when balance is a positive value under the $2 floor', () => {
		mockUseBillingUsage.mockReturnValue({ data: build({ credit_balance_cents: 185 }) })
		render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(
			screen.getByText(/Low credit balance \(\$1\.85\)\. Top up to keep your agents running\./),
		).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Top up credits' })).toBeInTheDocument()
	})

	it('does not render when balance is above the threshold', () => {
		mockUseBillingUsage.mockReturnValue({
			data: build({ credit_balance_cents: 5_000, sum_topups_last_30d_cents: 10_000 }),
		})
		render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.queryByTestId('low-balance-banner')).not.toBeInTheDocument()
	})

	it('does not render when balance is zero — that is the modal case, not a warning', () => {
		mockUseBillingUsage.mockReturnValue({
			data: build({ credit_balance_cents: 0, sum_topups_last_30d_cents: 10_000 }),
		})
		render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.queryByTestId('low-balance-banner')).not.toBeInTheDocument()
	})

	it('does not render while the usage query is still loading', () => {
		mockUseBillingUsage.mockReturnValue({ data: undefined })
		render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.queryByTestId('low-balance-banner')).not.toBeInTheDocument()
	})

	it('fires credits_low_balance_banner_shown exactly once on first render with threshold_used', () => {
		mockUseBillingUsage.mockReturnValue({ data: build({ credit_balance_cents: 185 }) })
		const { rerender } = render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(trackLowBalanceBannerShown).toHaveBeenCalledTimes(1)
		expect(trackLowBalanceBannerShown).toHaveBeenCalledWith({
			workspace_id: 'ws-1',
			balance_cents: 185,
			threshold_used: 200,
		})
		rerender(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(trackLowBalanceBannerShown).toHaveBeenCalledTimes(1)
	})

	it('emits threshold_used=1000 when 20% of recent burn dominates the $2 floor', () => {
		// $50 topups → 20% = 1000¢ — above the 200¢ floor
		mockUseBillingUsage.mockReturnValue({
			data: build({ credit_balance_cents: 500, sum_topups_last_30d_cents: 5_000 }),
		})
		render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(trackLowBalanceBannerShown).toHaveBeenCalledWith({
			workspace_id: 'ws-1',
			balance_cents: 500,
			threshold_used: 1_000,
		})
	})

	it('hides on dismiss and does not re-fire analytics after re-render', async () => {
		mockUseBillingUsage.mockReturnValue({ data: build({ credit_balance_cents: 185 }) })
		render(
			<TestWrapper>
				<LowBalanceBanner workspaceId="ws-1" />
			</TestWrapper>,
		)
		await userEvent.click(screen.getByRole('button', { name: 'Dismiss low balance warning' }))
		expect(screen.queryByTestId('low-balance-banner')).not.toBeInTheDocument()
		expect(trackLowBalanceBannerShown).toHaveBeenCalledTimes(1)
	})
})
