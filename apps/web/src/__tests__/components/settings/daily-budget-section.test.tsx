import { DailyBudgetSection, amountError } from '@/components/settings/daily-budget-section'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		billing: {
			dailyBudget: vi.fn(),
			setDailyBudget: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

const available = { available: true, reason: null, days: [] }
const LOCKED_REASON = 'Dollars are off for now. The cost numbers are not reliable yet.'
const saved = {
	unit: 'tokens' as const,
	amount: 2_000_000,
	stop_share: 90 as const,
	timezone: 'UTC',
}

function renderSection(canEdit = true) {
	return render(
		<TestWrapper>
			<DailyBudgetSection workspaceId="ws-1" canEdit={canEdit} />
		</TestWrapper>,
	)
}

describe('amountError', () => {
	it('accepts a positive whole token count and a dollar amount with cents', () => {
		expect(amountError('tokens', '2000000')).toBeNull()
		expect(amountError('dollars', '12.34')).toBeNull()
	})

	it.each([
		['tokens', ''],
		['tokens', '0'],
		['tokens', '-3'],
		['tokens', 'abc'],
		['dollars', '0'],
	] as const)('asks for a number above 0 for %s "%s"', (unit, value) => {
		expect(amountError(unit, value)).toBe('Enter a number above 0.')
	})

	it('rejects fractional tokens and sub-cent dollars', () => {
		expect(amountError('tokens', '1.5')).toBe('Enter a whole number of tokens.')
		expect(amountError('dollars', '1.005')).toBe('Dollars can have at most two decimals.')
	})
})

describe('DailyBudgetSection', () => {
	beforeEach(() => {
		vi.mocked(api.billing.dailyBudget).mockReset()
		vi.mocked(api.billing.setDailyBudget).mockReset()
	})

	it('is off by default: only the switch shows, no fields', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: null,
			dollar_unit: available,
		})
		renderSection()

		const toggle = await screen.findByRole('switch', { name: 'Set a daily target' })
		expect(toggle).not.toBeChecked()
		expect(screen.queryByLabelText('Target per day')).not.toBeInTheDocument()
	})

	it('shows the stored target and defaults the stop-at share to the stored value', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: available,
		})
		renderSection()

		expect(await screen.findByLabelText('Target per day')).toHaveValue('2000000')
		expect(screen.getByRole('radio', { name: '90%' })).toHaveAttribute('aria-checked', 'true')
		expect(screen.getByRole('radio', { name: 'Tokens' })).toHaveAttribute('aria-checked', 'true')
	})

	it('saves a new token target with the default 100% share and the browser timezone', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: null,
			dollar_unit: available,
		})
		vi.mocked(api.billing.setDailyBudget).mockResolvedValue({
			daily_budget: { unit: 'tokens', amount: 5_000_000, stop_share: 100, timezone: 'UTC' },
			dollar_unit: available,
		})
		renderSection()

		await user.click(await screen.findByRole('switch', { name: 'Set a daily target' }))
		await user.type(screen.getByLabelText('Target per day'), '5000000')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(api.billing.setDailyBudget).toHaveBeenCalledTimes(1))
		expect(api.billing.setDailyBudget).toHaveBeenCalledWith('ws-1', {
			unit: 'tokens',
			amount: 5_000_000,
			stop_share: 100,
			timezone: expect.any(String),
		})
	})

	it('blocks Save and explains an invalid amount', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: null,
			dollar_unit: available,
		})
		renderSection()

		await user.click(await screen.findByRole('switch', { name: 'Set a daily target' }))
		await user.type(screen.getByLabelText('Target per day'), '0')

		expect(screen.getByText('Enter a number above 0.')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		expect(api.billing.setDailyBudget).not.toHaveBeenCalled()
	})

	it('locks the Dollars option and says why when cost numbers are unreliable', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: { available: false, reason: LOCKED_REASON, days: [] },
		})
		renderSection()

		await screen.findByLabelText('Target per day')
		const dollars = screen.getByRole('radio', { name: 'Dollars' })
		expect(dollars).toBeDisabled()
		expect(screen.getByText(LOCKED_REASON)).toBeInTheDocument()
		await user.click(dollars)
		expect(screen.getByRole('radio', { name: 'Tokens' })).toHaveAttribute('aria-checked', 'true')
	})

	it('saves null when the switch is turned off', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: available,
		})
		vi.mocked(api.billing.setDailyBudget).mockResolvedValue({
			daily_budget: null,
			dollar_unit: available,
		})
		renderSection()

		await user.click(await screen.findByRole('switch', { name: 'Set a daily target' }))
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(api.billing.setDailyBudget).toHaveBeenCalledWith('ws-1', null))
	})

	it('shows an inline error and keeps the typed values when saving fails', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: available,
		})
		vi.mocked(api.billing.setDailyBudget).mockRejectedValue(new Error('boom'))
		renderSection()

		const amount = await screen.findByLabelText('Target per day')
		await user.clear(amount)
		await user.type(amount, '3000000')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Could not save. Your target is unchanged. Try again.',
		)
		expect(amount).toHaveValue('3000000')
	})

	it('is read-only for someone who cannot manage billing', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: available,
		})
		renderSection(false)

		expect(await screen.findByLabelText('Target per day')).toBeDisabled()
		expect(screen.getByRole('switch', { name: 'Set a daily target' })).toBeDisabled()
		expect(
			screen.getByText('Only workspace owners and admins can change the daily budget.'),
		).toBeInTheDocument()
	})
})
