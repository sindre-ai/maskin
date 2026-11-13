import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			billing: {
				usage: vi.fn(),
				trial: {
					setup: vi.fn(),
					start: vi.fn(),
					checkPromo: vi.fn(),
					startWithPromo: vi.fn(),
				},
			},
		},
	}
})

vi.mock('@/lib/welcome-landing', () => ({ welcomeLandingPath: vi.fn().mockResolvedValue('/ws') }))
vi.mock('@/components/billing/plan-picker', () => ({ PlanPicker: () => null }))
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn().mockResolvedValue({}) }))
vi.mock('@stripe/react-stripe-js', () => ({
	Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PaymentElement: () => <div data-testid="card-fields" />,
	useStripe: () => ({ confirmSetup: vi.fn() }),
	useElements: () => ({}),
}))
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useParams: () => ({ workspaceId: 'ws-1' }),
		}),
	}
})

import { ApiError, api } from '@/lib/api'
import { Route } from '@/routes/_authed/start-trial.$workspaceId'

const StartTrialPage = (Route as unknown as { component: React.FC }).component

const trial = vi.mocked(api.billing.trial)

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	return render(
		<QueryClientProvider client={client}>
			<StartTrialPage />
		</QueryClientProvider>,
	)
}

async function apply(user: ReturnType<typeof userEvent.setup>, code: string) {
	await user.type(await screen.findByLabelText('Promo code'), code)
	await user.click(screen.getByRole('button', { name: 'Apply' }))
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(api.billing.usage).mockResolvedValue({ trial_state: 'awaiting_card' } as never)
	trial.setup.mockResolvedValue({ client_secret: 'seti_secret', publishable_key: 'pk_test' })
})

describe('start-trial page promo code', () => {
	it('shows the Promo code field above the card form', async () => {
		renderPage()
		const field = await screen.findByLabelText('Promo code')
		const card = await screen.findByTestId('card-fields')
		expect(field.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('folds the card form away for a valid code and starts the trial with no card', async () => {
		const user = userEvent.setup()
		trial.checkPromo.mockResolvedValue({ valid: true })
		trial.startWithPromo.mockResolvedValue({ trial_state: 'started', trial_ends_at: 1 })
		renderPage()
		await screen.findByTestId('card-fields')

		await apply(user, 'friends-2026')

		expect(await screen.findByText('Promo code applied, no card needed.')).toBeTruthy()
		expect(screen.queryByTestId('card-fields')).toBeNull()
		await user.click(screen.getByRole('button', { name: 'Start 7-day trial' }))
		await waitFor(() => expect(trial.startWithPromo).toHaveBeenCalledWith('ws-1', 'friends-2026'))
		expect(trial.start).not.toHaveBeenCalled()
	})

	it('keeps the card form and says so for an invalid, expired or used up code', async () => {
		const user = userEvent.setup()
		trial.checkPromo.mockResolvedValue({ valid: false })
		renderPage()
		await screen.findByTestId('card-fields')

		await apply(user, 'nope-1234')

		expect(await screen.findByText(/not valid, or it has been used up/)).toBeTruthy()
		expect(screen.getByTestId('card-fields')).toBeTruthy()
		expect(trial.startWithPromo).not.toHaveBeenCalled()
	})

	it('opens the card form again when the code is removed', async () => {
		const user = userEvent.setup()
		trial.checkPromo.mockResolvedValue({ valid: true })
		renderPage()
		await screen.findByTestId('card-fields')
		await apply(user, 'friends-2026')
		await screen.findByText('Promo code applied, no card needed.')

		await user.click(screen.getByRole('button', { name: 'Remove' }))

		expect(await screen.findByTestId('card-fields')).toBeTruthy()
		expect((screen.getByLabelText('Promo code') as HTMLInputElement).value).toBe('')
		expect(trial.setup).toHaveBeenCalledTimes(1)
	})

	it('brings the card form back when the server finds the code no longer valid at start', async () => {
		const user = userEvent.setup()
		trial.checkPromo.mockResolvedValue({ valid: true })
		const err = new ApiError(400, 'This promo code is not valid, or it has been used up.')
		err.code = 'TRIAL_PROMO_CODE_INVALID'
		trial.startWithPromo.mockRejectedValue(err)
		renderPage()
		await screen.findByTestId('card-fields')
		await apply(user, 'friends-2026')
		await user.click(await screen.findByRole('button', { name: 'Start 7-day trial' }))

		expect(await screen.findByText(/no longer valid/)).toBeTruthy()
		expect(await screen.findByTestId('card-fields')).toBeTruthy()
	})

	it('asks the person to wait when the server rate limits the tries', async () => {
		const user = userEvent.setup()
		trial.checkPromo.mockRejectedValue(new ApiError(429, 'Too many promo code tries.'))
		renderPage()
		await screen.findByTestId('card-fields')

		await apply(user, 'guess-0001')

		expect(await screen.findByText(/Too many tries/)).toBeTruthy()
		expect(screen.getByTestId('card-fields')).toBeTruthy()
	})
})
