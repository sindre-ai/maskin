import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		billing: {
			summary: vi.fn(),
			startCheckout: vi.fn(),
			complete: vi.fn(),
			portal: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import {
	useBillingSummary,
	useCompleteCheckout,
	useOpenPortal,
	useStartCheckout,
} from '@/hooks/use-billing'
import { api } from '@/lib/api'
import type { BillingSummaryResponse } from '@/lib/api'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

function buildSummary(overrides: Partial<BillingSummaryResponse> = {}): BillingSummaryResponse {
	return {
		configured: true,
		testMode: true,
		publishableKey: 'pk_test_abc',
		plan: {
			planId: 'pro',
			planLabel: 'Pro',
			status: 'active',
			priceCents: 12000,
			currency: 'usd',
			nextChargeAt: null,
		},
		invoiceEmail: 'billing@acme.dev',
		invoices: [],
		...overrides,
	}
}

describe('useBillingSummary', () => {
	beforeEach(() => vi.clearAllMocks())

	it('fetches the billing summary for the workspace', async () => {
		const summary = buildSummary()
		vi.mocked(api.billing.summary).mockResolvedValue(summary)

		const { result } = renderHook(() => useBillingSummary('ws-1'), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(summary)
		expect(api.billing.summary).toHaveBeenCalledWith('ws-1')
	})
})

describe('useStartCheckout', () => {
	beforeEach(() => vi.clearAllMocks())

	it('starts a checkout and returns the client secret', async () => {
		vi.mocked(api.billing.startCheckout).mockResolvedValue({
			clientSecret: 'pi_1_secret',
			testMode: true,
			plan: buildSummary().plan,
		})

		const { result } = renderHook(() => useStartCheckout('ws-1'), { wrapper: TestWrapper })
		result.current.mutate('billing@acme.dev')

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.billing.startCheckout).toHaveBeenCalledWith('ws-1', 'billing@acme.dev')
		expect(result.current.data?.clientSecret).toBe('pi_1_secret')
	})
})

describe('useCompleteCheckout', () => {
	beforeEach(() => vi.clearAllMocks())

	it('confirms the payment intent, toasts, and forwards the invoice email', async () => {
		vi.mocked(api.billing.complete).mockResolvedValue(buildSummary())

		const { result } = renderHook(() => useCompleteCheckout('ws-1'), { wrapper: TestWrapper })
		result.current.mutate({ paymentIntentId: 'pi_1', invoiceEmail: 'billing@acme.dev' })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.billing.complete).toHaveBeenCalledWith('ws-1', 'pi_1', 'billing@acme.dev')
		expect(toast.success).toHaveBeenCalledWith('Payment confirmed — plan activated')
	})
})

describe('useOpenPortal', () => {
	beforeEach(() => vi.clearAllMocks())

	it('opens the Stripe customer portal in the current tab', async () => {
		vi.mocked(api.billing.portal).mockResolvedValue({ url: 'https://billing.stripe.com/session/x' })
		const originalHref = window.location.href
		Object.defineProperty(window, 'location', {
			value: { href: originalHref },
			writable: true,
		})

		const { result } = renderHook(() => useOpenPortal('ws-1'), { wrapper: TestWrapper })
		result.current.mutate()

		await waitFor(() => expect(api.billing.portal).toHaveBeenCalledWith('ws-1'))
		await waitFor(() => expect(window.location.href).toBe('https://billing.stripe.com/session/x'))
	})
})
