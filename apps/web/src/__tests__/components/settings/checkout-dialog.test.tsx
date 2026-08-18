import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingSummaryResponse } from '@/lib/api'

const mockSummary = { current: null as BillingSummaryResponse | null }
const mockStartCheckout = {
	mutate: vi.fn(),
	reset: vi.fn(),
	data: null as { clientSecret: string } | null,
}

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
	useOpenPortal: () => ({ mutate: vi.fn(), isPending: false }),
	useStartCheckout: () => mockStartCheckout,
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

function activeSummary(): BillingSummaryResponse {
	return {
		configured: true,
		testMode: false,
		publishableKey: 'pk_test_123',
		plan: {
			planId: 'pro',
			planLabel: 'Pro',
			status: 'inactive',
			priceCents: 2000,
			currency: 'usd',
			nextChargeAt: null,
		},
		invoiceEmail: null,
		invoices: [],
	}
}

async function openCheckout() {
	const user = userEvent.setup()
	render(<BillingPage />)
	await user.click(screen.getByRole('button', { name: 'Change plan' }))
	return user
}

describe('Billing > CheckoutDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSummary.current = activeSummary()
		mockStartCheckout.data = { clientSecret: 'cs_test_123' }
	})

	it('renders the order summary with the plan price as the amount due today', async () => {
		await openCheckout()

		expect(screen.getByText('Subscribe to Pro')).toBeInTheDocument()
		expect(screen.getByText(/Billing for Vaerksted/)).toBeInTheDocument()
		expect(screen.getByText('Due today')).toBeInTheDocument()
		expect(screen.getByText('$20.00')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Subscribe · $20.00 / month' })).toBeInTheDocument()
	})

	// Regression guard: the checkout failure and the Stripe reassurance used to
	// share one <p>, so a failed checkout rendered as a single run-on sentence.
	it('keeps the server error and the Stripe security line in separate elements', async () => {
		mockStartCheckout.data = null
		mockStartCheckout.mutate = vi.fn((_input, options) => {
			options?.onError?.(new Error('Could not start checkout'))
		})
		await openCheckout()

		const security = screen.getByText(
			'Secured by Stripe. Maskin never sees or stores your card number.',
		)
		const error = screen.getByText('Could not start checkout')
		expect(security).toBeInTheDocument()
		expect(error).toBeInTheDocument()
		expect(error).not.toBe(security)
		expect(security.textContent).toBe(
			'Secured by Stripe. Maskin never sees or stores your card number.',
		)
	})
})
