import { PlanPicker } from '@/components/billing/plan-picker'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('PlanPicker', () => {
	it('lists the three sellable plans in kroner and starts on Pro for a free workspace', () => {
		render(<PlanPicker current="trial" pending={false} onContinue={vi.fn()} />)

		expect(screen.getByText('Prices are per month, excluding VAT.')).toBeInTheDocument()
		expect(screen.getAllByRole('radio')).toHaveLength(3)
		expect(screen.getByText('349 kr')).toBeInTheDocument()
		expect(screen.getByText('995 kr')).toBeInTheDocument()
		expect(screen.getByText('4.995 kr')).toBeInTheDocument()
		expect(screen.queryByText('549 kr')).not.toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Pro 995 kr' })).toBeChecked()
		expect(screen.getByRole('button', { name: 'Continue with Pro' })).toBeInTheDocument()
	})

	it('preselects the current paid plan and continues with the chosen one', async () => {
		const user = userEvent.setup()
		const onContinue = vi.fn()
		render(<PlanPicker current="pro" pending={false} onContinue={onContinue} />)

		expect(screen.getByRole('radio', { name: 'Pro 995 kr' })).toBeChecked()
		await user.click(screen.getByRole('radio', { name: 'Ultra 4.995 kr' }))
		await user.click(screen.getByRole('button', { name: 'Continue with Ultra' }))

		expect(onContinue).toHaveBeenCalledWith('ultra')
	})

	it('disables the button while checkout opens', () => {
		render(<PlanPicker current="trial" pending onContinue={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'Opening checkout…' })).toBeDisabled()
	})
})
