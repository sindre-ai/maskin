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

const saved = {
	unit: 'percent' as const,
	amount: 4.5,
	stop_share: 90 as const,
	timezone: 'UTC',
}
const off = { daily_budget: null, earlier_target: null, plan_limit_known: true }
const on = { daily_budget: saved, earlier_target: null, plan_limit_known: true }

function renderSection(canEdit = true) {
	return render(
		<TestWrapper>
			<DailyBudgetSection workspaceId="ws-1" canEdit={canEdit} />
		</TestWrapper>,
	)
}

describe('amountError', () => {
	it.each(['3', '3.3', '0.1', '100'])('accepts %s', (value) => {
		expect(amountError(value)).toBeNull()
	})

	it.each(['', '0', '-3', 'abc'])('asks for a number above 0 for "%s"', (value) => {
		expect(amountError(value)).toBe('Enter a number above 0.')
	})

	it('rejects more than 100 and more than one decimal', () => {
		expect(amountError('100.5')).toBe('Enter 100 or less.')
		expect(amountError('3.33')).toBe('Use at most one decimal.')
	})
})

describe('DailyBudgetSection', () => {
	beforeEach(() => {
		vi.mocked(api.billing.dailyBudget).mockReset()
		vi.mocked(api.billing.setDailyBudget).mockReset()
	})

	it('is off by default: only the switch shows, no fields', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(off)
		renderSection()

		const toggle = await screen.findByRole('switch', { name: 'Set a daily target' })
		expect(toggle).not.toBeChecked()
		expect(screen.queryByLabelText('Target per day')).not.toBeInTheDocument()
	})

	it('shows the stored target as a percent of the plan, with no unit choice', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(on)
		renderSection()

		expect(await screen.findByLabelText('Target per day')).toHaveValue('4.5')
		expect(screen.getByText('% of your plan')).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: '90%' })).toHaveAttribute('aria-checked', 'true')
		expect(screen.queryByRole('radio', { name: 'Tokens' })).not.toBeInTheDocument()
		expect(screen.queryByRole('radio', { name: 'Dollars' })).not.toBeInTheDocument()
		expect(screen.queryByText(/token|dollar|\$/i)).not.toBeInTheDocument()
	})

	it('saves a new percent target with the default 100% share and the browser timezone', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(off)
		vi.mocked(api.billing.setDailyBudget).mockResolvedValue({
			...on,
			daily_budget: { unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' },
		})
		renderSection()

		await user.click(await screen.findByRole('switch', { name: 'Set a daily target' }))
		await user.type(screen.getByLabelText('Target per day'), '5')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(api.billing.setDailyBudget).toHaveBeenCalledTimes(1))
		expect(api.billing.setDailyBudget).toHaveBeenCalledWith('ws-1', {
			unit: 'percent',
			amount: 5,
			stop_share: 100,
			timezone: expect.any(String),
		})
	})

	it('blocks Save and explains an invalid amount', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(off)
		renderSection()

		await user.click(await screen.findByRole('switch', { name: 'Set a daily target' }))
		await user.type(screen.getByLabelText('Target per day'), '0')

		expect(screen.getByText('Enter a number above 0.')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		expect(api.billing.setDailyBudget).not.toHaveBeenCalled()
	})

	it('shows an earlier target that was converted, and offers Save to keep it', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			...on,
			earlier_target: { unit: 'dollars', converted: true },
		})
		renderSection()

		expect(await screen.findByLabelText('Target per day')).toHaveValue('4.5')
		expect(
			screen.getByText(
				'Your earlier daily target is shown here as a percent of your plan. Save to keep it.',
			),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
	})

	it('suggests the default when an earlier target could not be converted', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: { ...saved, amount: 3.3 },
			earlier_target: { unit: 'tokens', converted: false },
			plan_limit_known: true,
		})
		renderSection()

		expect(await screen.findByLabelText('Target per day')).toHaveValue('3.3')
		expect(
			screen.getByText(
				'Your earlier daily target could not be turned into a percent of your plan, so 3.3% a day is suggested. Save to use it.',
			),
		).toBeInTheDocument()
	})

	it('says no card is sent when the plan has no limit to take a percent of', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({ ...on, plan_limit_known: false })
		renderSection()

		expect(
			await screen.findByText(
				'Your plan has no usage limit to take a percent of, so no daily card is sent.',
			),
		).toBeInTheDocument()
	})

	it('makes each pill group one Tab stop and moves selection with the arrow keys', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: available,
		})
		renderSection()

		await screen.findByLabelText('Target per day')
		const tokens = screen.getByRole('radio', { name: 'Tokens' })
		const dollars = screen.getByRole('radio', { name: 'Dollars' })
		expect(tokens).toHaveAttribute('tabindex', '0')
		expect(dollars).toHaveAttribute('tabindex', '-1')

		tokens.focus()
		await user.keyboard('{ArrowRight}')
		expect(dollars).toHaveAttribute('aria-checked', 'true')
		expect(dollars).toHaveFocus()
		expect(dollars).toHaveAttribute('tabindex', '0')
		expect(tokens).toHaveAttribute('tabindex', '-1')

		await user.keyboard('{ArrowUp}')
		expect(tokens).toHaveAttribute('aria-checked', 'true')
		expect(tokens).toHaveFocus()
	})

	it('skips the locked Dollars pill when arrowing', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue({
			daily_budget: saved,
			dollar_unit: { available: false, reason: LOCKED_REASON, days: [] },
		})
		renderSection()

		await screen.findByLabelText('Target per day')
		const tokens = screen.getByRole('radio', { name: 'Tokens' })
		tokens.focus()
		await user.keyboard('{ArrowRight}')
		expect(tokens).toHaveAttribute('aria-checked', 'true')
		expect(tokens).toHaveFocus()
	})

	it('saves null when the switch is turned off', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(on)
		vi.mocked(api.billing.setDailyBudget).mockResolvedValue(off)
		renderSection()

		await user.click(await screen.findByRole('switch', { name: 'Set a daily target' }))
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(api.billing.setDailyBudget).toHaveBeenCalledWith('ws-1', null))
	})

	it('shows an inline error and keeps the typed values when saving fails', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(on)
		vi.mocked(api.billing.setDailyBudget).mockRejectedValue(new Error('boom'))
		renderSection()

		const amount = await screen.findByLabelText('Target per day')
		await user.clear(amount)
		await user.type(amount, '6')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Could not save. Your target is unchanged. Try again.',
		)
		expect(amount).toHaveValue('6')
	})

	it('is read-only for someone who cannot manage billing', async () => {
		vi.mocked(api.billing.dailyBudget).mockResolvedValue(on)
		renderSection(false)

		expect(await screen.findByLabelText('Target per day')).toBeDisabled()
		expect(screen.getByRole('switch', { name: 'Set a daily target' })).toBeDisabled()
		expect(
			screen.getByText('Only workspace owners and admins can change the daily budget.'),
		).toBeInTheDocument()
	})
})
