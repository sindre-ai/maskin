import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingSummaryResponse } from '@/lib/api'

const mockSummary = { current: null as BillingSummaryResponse | null }
const mockPortalMutate = vi.fn()
const mockStartCheckoutMutate = vi.fn()
const mockStartCheckoutReset = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { id: 'ws-1', name: 'Vaerksted' } }),
}))

vi.mock('@/hooks/use-billing', () => ({
	useBillingSummary: () => ({ data: mockSummary.current, isLoading: false }),
	useOpenPortal: () => ({ mutate: mockPortalMutate, isPending: false }),
	useStartCheckout: () => ({
		mutate: mockStartCheckoutMutate,
		reset: mockStartCheckoutReset,
		data: { clientSecret: 'cs_test_123' },
	}),
	useCompleteCheckout: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@stripe/stripe-js', () => ({
	loadStripe: () => Promise.resolve(null),
}))

vi.mock('@stripe/react-stripe-js', () => ({
	Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PaymentElement: () => <div data-testid="payment-element" />,
	useStripe: () => ({}),
	useElements: () => ({}),
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/billing'

const BillingPage = (Route as unknown as { component: React.FC }).component

function buildSummary(overrides: Partial<BillingSummaryResponse> = {}): BillingSummaryResponse {
	return {
		configured: false,
		testMode: false,
		publishableKey: null,
		plan: {
			planId: 'free',
			planLabel: 'Free',
			status: 'inactive',
			priceCents: null,
			currency: 'usd',
			nextChargeAt: null,
		},
		invoiceEmail: null,
		invoices: [],
		...overrides,
	}
}

describe('BillingPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSummary.current = buildSummary()
	})

	it('renders the free-plan banner with no active subscription and the Stripe notice', () => {
		render(<BillingPage />)

		expect(screen.getByRole('heading', { name: 'Free' })).toBeInTheDocument()
		expect(screen.getByText('No active subscription')).toBeInTheDocument()
		expect(screen.getByText(/Stripe is not configured for this instance/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Change plan' })).toBeDisabled()
	})

	it('keeps the payment disclosure closed when there are no invoices and opens it on Show', async () => {
		const user = userEvent.setup()
		render(<BillingPage />)

		expect(screen.queryByText('PAYMENT METHOD')).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /Payment, details and invoices/ }))

		expect(screen.getByRole('heading', { name: 'PAYMENT METHOD' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'BILLING DETAILS' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'INVOICES' })).toBeInTheDocument()
		expect(screen.getByText('No invoices yet')).toBeInTheDocument()
		expect(screen.getByText('Not set')).toBeInTheDocument()
	})

	// Nothing cancels a subscription that does not exist — the affordance only
	// appears once the plan is actually active.
	it('hides Cancel subscription while the plan is inactive', async () => {
		const user = userEvent.setup()
		render(<BillingPage />)
		await user.click(screen.getByRole('button', { name: /Payment, details and invoices/ }))

		expect(screen.queryByRole('button', { name: 'Cancel subscription' })).not.toBeInTheDocument()
	})

	it('opens the disclosure by default and shows Cancel subscription for an active plan', () => {
		mockSummary.current = buildSummary({
			configured: true,
			plan: {
				planId: 'pro',
				planLabel: 'Pro',
				status: 'active',
				priceCents: 2000,
				currency: 'usd',
				nextChargeAt: '2026-09-01T00:00:00.000Z',
			},
			invoiceEmail: 'billing@vaerksted.ai',
			invoices: [
				{
					id: 'in_1',
					description: 'Pro — August',
					amountCents: 2000,
					currency: 'usd',
					status: 'paid',
					billedAt: '2026-08-04T00:00:00.000Z',
				},
			],
		})
		render(<BillingPage />)

		expect(screen.getByRole('heading', { name: 'INVOICES' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument()
		expect(screen.getByText('billing@vaerksted.ai')).toBeInTheDocument()
	})

	// A financial record gets an absolute date, never "2 weeks ago" (mockup 2925).
	it('renders the invoice date absolutely and the status through StatusBadge', () => {
		mockSummary.current = buildSummary({
			plan: {
				planId: 'pro',
				planLabel: 'Pro',
				status: 'active',
				priceCents: 2000,
				currency: 'usd',
				nextChargeAt: null,
			},
			invoices: [
				{
					id: 'in_1',
					description: 'Pro — August',
					amountCents: 2000,
					currency: 'usd',
					status: 'paid',
					billedAt: '2026-08-04T00:00:00.000Z',
				},
			],
		})
		render(<BillingPage />)

		const row = screen.getByText('Pro — August').closest('tr') as HTMLElement
		expect(within(row).getByText('4 Aug 2026')).toBeInTheDocument()
		expect(within(row).queryByText(/ago/)).not.toBeInTheDocument()

		// The billing statuses were missing from `statusColors`, so `paid` fell
		// through to the zinc-700 fallback pill. Guard the mapping.
		const badge = within(row).getByText('paid')
		expect(badge.className).not.toContain('bg-zinc-700')
		expect(badge.className).toContain('bg-status-succeeded-bg')
	})
})
