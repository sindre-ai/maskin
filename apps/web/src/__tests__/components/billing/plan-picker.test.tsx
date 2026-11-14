import { PlanPicker } from '@/components/billing/plan-picker'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('PlanPicker', () => {
	it('lists the four paid plans in kroner and starts on Pro for a trial', () => {
		render(<PlanPicker current="trial" pending={false} onContinue={vi.fn()} />)

		expect(screen.getByText('Prices are per month, excluding VAT.')).toBeInTheDocument()
		expect(screen.getAllByRole('radio')).toHaveLength(4)
		expect(screen.getByText('99 kr')).toBeInTheDocument()
		expect(screen.getByText('249 kr')).toBeInTheDocument()
		expect(screen.getByText('549 kr')).toBeInTheDocument()
		expect(screen.getByText('1.499 kr')).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Pro 249 kr' })).toBeChecked()
		expect(screen.getByRole('button', { name: 'Continue with Pro' })).toBeInTheDocument()
	})

	it('preselects the current paid plan and continues with the chosen one', async () => {
		const user = userEvent.setup()
		const onContinue = vi.fn()
		render(<PlanPicker current="team" pending={false} onContinue={onContinue} />)

		expect(screen.getByRole('radio', { name: 'Team 549 kr' })).toBeChecked()
		await user.click(screen.getByRole('radio', { name: 'Ultra 1.499 kr' }))
		await user.click(screen.getByRole('button', { name: 'Continue with Ultra' }))

		expect(onContinue).toHaveBeenCalledWith('ultra')
	})

	it('disables the button while checkout opens', () => {
		render(<PlanPicker current="trial" pending onContinue={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'Opening checkout…' })).toBeDisabled()
	})
})
