import { useUsageState } from '@/hooks/use-usage-state'
import type { BillingUsageResponse } from '@/lib/api'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

const mockBilling = vi.fn<(workspaceId: string) => { data: BillingUsageResponse | undefined }>()

vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: (workspaceId: string) => mockBilling(workspaceId),
}))

function build(overrides: Partial<BillingUsageResponse> = {}): BillingUsageResponse {
	return {
		plan: 'trial',
		status: 'active',
		usd_cents_used: 0,
		hard_cap_usd_cents: 500,
		period_start: null,
		period_resets_in_ms: null,
		stripe_customer_id: null,
		stripe_subscription_id: null,
		credit_balance_cents: 0,
		linkedin_identity_addon: null,
		...overrides,
	}
}

describe('useUsageState', () => {
	it('returns unknown until the billing hook resolves', () => {
		mockBilling.mockReturnValue({ data: undefined })
		const { result } = renderHook(() => useUsageState('ws-1'), { wrapper: TestWrapper })
		expect(result.current.credits_state).toBe('unknown')
	})

	it('is empty when trial cap is exhausted and prepaid balance is zero', () => {
		mockBilling.mockReturnValue({
			data: build({ plan: 'trial', usd_cents_used: 500, hard_cap_usd_cents: 500 }),
		})
		const { result } = renderHook(() => useUsageState('ws-1'), { wrapper: TestWrapper })
		expect(result.current.credits_state).toBe('empty')
	})

	it('is ok when there are prepaid credits even with exhausted cap', () => {
		mockBilling.mockReturnValue({
			data: build({ usd_cents_used: 500, hard_cap_usd_cents: 500, credit_balance_cents: 100 }),
		})
		const { result } = renderHook(() => useUsageState('ws-1'), { wrapper: TestWrapper })
		expect(result.current.credits_state).toBe('ok')
	})

	it('is ok when included usage remains under the cap', () => {
		mockBilling.mockReturnValue({
			data: build({ plan: 'pro', usd_cents_used: 100, hard_cap_usd_cents: 500 }),
		})
		const { result } = renderHook(() => useUsageState('ws-1'), { wrapper: TestWrapper })
		expect(result.current.credits_state).toBe('ok')
	})

	it('is never empty on enterprise workspaces', () => {
		mockBilling.mockReturnValue({
			data: build({
				plan: 'enterprise',
				usd_cents_used: 9_999_999,
				hard_cap_usd_cents: 0,
				credit_balance_cents: 0,
			}),
		})
		const { result } = renderHook(() => useUsageState('ws-1'), { wrapper: TestWrapper })
		expect(result.current.credits_state).toBe('ok')
	})

	it('treats a null hard cap as unbounded included usage', () => {
		mockBilling.mockReturnValue({
			data: build({ plan: 'pro', usd_cents_used: 1_000_000, hard_cap_usd_cents: null }),
		})
		const { result } = renderHook(() => useUsageState('ws-1'), { wrapper: TestWrapper })
		expect(result.current.credits_state).toBe('ok')
	})
})
