import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingSummaryResponse } from '@/lib/api'
import { TestWrapper } from '../../setup'

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

// The page's usage block reads GET /sessions/usage per agent; an agentless
// workspace keeps the checkout specs focused on the dialog.
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
	render(<BillingPage />, { wrapper: TestWrapper })
	// The fixture plan is inactive, so the strip's action reads "Choose a plan".
	await user.click(screen.getByRole('button', { name: 'Choose a plan' }))
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
		// Scoped to the dialog: the Pro card on the page behind it quotes the same
		// price, because a sold tier renders the API's amount and not the
		// catalogue's.
		expect(within(screen.getByRole('dialog')).getByText('$20.00')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Subscribe · $20.00 / month' })).toBeInTheDocument()
	})

	// Mockup 3030 — the fine print states only what this checkout does: one
	// charge now, everything after it on Stripe. No renewal or included-usage
	// claim, because neither is modelled anywhere in the API.
	it('renders the terms fine print under the order summary', async () => {
		await openCheckout()

		expect(
			screen.getByText(
				'One charge of $20.00 today. Your plan, card and any future charges are managed on Stripe.',
			),
		).toBeInTheDocument()
	})

	// Neither an in-modal plan chooser nor included-usage lines can be rendered:
	// the instance resolves exactly one plan and the API returns no usage
	// allowance. Guard against a future placeholder creeping in.
	it('omits the plan chooser and the included-usage lines', async () => {
		await openCheckout()

		expect(screen.queryByText('Included usage')).not.toBeInTheDocument()
		expect(screen.queryByText('Beyond that')).not.toBeInTheDocument()
		expect(screen.queryByText('NAME ON CARD')).not.toBeInTheDocument()
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
