import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingSummaryResponse } from '@/lib/api'
import { TestWrapper } from '../../setup'

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

// The usage block sums `GET /sessions/usage` per agent; with no agents it has
// nothing to fetch and renders its no-usage line.
vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		api: {
			actors: { list: vi.fn().mockResolvedValue([]) },
			sessions: { usage: vi.fn() },
		},
	}
})

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
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.getByRole('heading', { name: 'Free' })).toBeInTheDocument()
		expect(screen.getByText('No active subscription')).toBeInTheDocument()
		expect(screen.getByText(/Stripe is not configured for this instance/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Change plan' })).toBeDisabled()
	})

	it('keeps the payment disclosure closed when there are no invoices and opens it on Show', async () => {
		const user = userEvent.setup()
		render(<BillingPage />, { wrapper: TestWrapper })

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
		render(<BillingPage />, { wrapper: TestWrapper })
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
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.getByRole('heading', { name: 'INVOICES' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument()
		expect(screen.getByText('billing@vaerksted.ai')).toBeInTheDocument()
	})

	// Mockup 2803-2813. With no agent sessions there is no figure to show, and
	// no meter is drawn either way — the "included usage" ceiling has no field.
	it('states there is no model usage this month instead of showing a zero figure', async () => {
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(await screen.findByText('No model usage recorded this month yet.')).toBeInTheDocument()
		expect(screen.getByText(/resets/)).toBeInTheDocument()
	})

	// Mockup 2797 — the warn variant, limited to states the billing row holds.
	it('warns on the plan banner when the last payment was declined', () => {
		mockSummary.current = buildSummary({
			configured: true,
			plan: {
				planId: 'pro',
				planLabel: 'Pro',
				status: 'declined',
				priceCents: 2000,
				currency: 'usd',
				nextChargeAt: null,
			},
		})
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.getByText(/The last payment was declined/)).toBeInTheDocument()
	})

	it('shows no warning banner for a healthy plan', () => {
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.queryByText(/last payment was declined/)).not.toBeInTheDocument()
		expect(screen.queryByText(/past due/)).not.toBeInTheDocument()
	})

	// Mockup 2894-2905. Card-present is inferred from an active plan (a Stripe
	// Customer exists only after a payment succeeded) — never from invented
	// brand/last4 fields, which the summary endpoint does not return.
	it('renders the no-card state while no payment has ever succeeded', async () => {
		const user = userEvent.setup()
		render(<BillingPage />, { wrapper: TestWrapper })
		await user.click(screen.getByRole('button', { name: /Payment, details and invoices/ }))

		expect(screen.getByText(/No card on file/)).toBeInTheDocument()
		expect(screen.queryByText(/A card is on file with Stripe/)).not.toBeInTheDocument()
	})

	it('renders the card-present state once the plan is active', () => {
		mockSummary.current = buildSummary({
			configured: true,
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
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.getByText(/A card is on file with Stripe/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
		expect(screen.queryByText(/No card on file/)).not.toBeInTheDocument()
	})

	// Mockup 2911-2916 — a row list, one row per field the API actually returns.
	it('lists billing details as rows with the next charge date when the API has one', () => {
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
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.getByText('Billing email')).toBeInTheDocument()
		expect(screen.getByText('billing@vaerksted.ai')).toBeInTheDocument()
		expect(screen.getByText('Plan')).toBeInTheDocument()
		expect(screen.getByText('Pro · $20.00 / month')).toBeInTheDocument()
		expect(screen.getByText('Next charge')).toBeInTheDocument()
		// Formatted in the runner's timezone — assert the same derivation, not a
		// literal, so the test does not depend on where it runs.
		const expectedDate = new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
		}).format(new Date('2026-09-01T00:00:00.000Z'))
		expect(screen.getByText(expectedDate)).toBeInTheDocument()
	})

	it('omits the next-charge row when the API has no next charge date', () => {
		mockSummary.current = buildSummary({
			configured: true,
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
		render(<BillingPage />, { wrapper: TestWrapper })

		expect(screen.getByText('Billing email')).toBeInTheDocument()
		expect(screen.queryByText('Next charge')).not.toBeInTheDocument()
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
		render(<BillingPage />, { wrapper: TestWrapper })

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
