import { DecisionPoint } from '@/components/pulse/decision-point'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('DecisionPoint', () => {
	const options = [
		{ label: 'Option A', value: 'a', description: 'First option' },
		{ label: 'Option B', value: 'b' },
	]

	it('renders question text', () => {
		render(<DecisionPoint question="Which approach?" options={options} onConfirm={vi.fn()} />)
		expect(screen.getByText('Which approach?')).toBeInTheDocument()
	})

	it('renders all option labels', () => {
		render(<DecisionPoint question="Pick one" options={options} onConfirm={vi.fn()} />)
		expect(screen.getByText('Option A')).toBeInTheDocument()
		expect(screen.getByText('Option B')).toBeInTheDocument()
	})

	it('renders option descriptions when provided', () => {
		render(<DecisionPoint question="Pick one" options={options} onConfirm={vi.fn()} />)
		expect(screen.getByText('First option')).toBeInTheDocument()
	})

	it('confirm button is disabled until selection is made', () => {
		render(<DecisionPoint question="Pick one" options={options} onConfirm={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
	})

	it('calls onConfirm with selected value', async () => {
		const user = userEvent.setup()
		const onConfirm = vi.fn()
		render(<DecisionPoint question="Pick one" options={options} onConfirm={onConfirm} />)

		await user.click(screen.getByText('Option A'))
		await user.click(screen.getByRole('button', { name: 'Confirm' }))
		expect(onConfirm).toHaveBeenCalledWith('a')
	})
})
