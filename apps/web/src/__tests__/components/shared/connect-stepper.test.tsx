import { ConnectStepper } from '@/components/shared/connect-stepper'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('ConnectStepper', () => {
	it('renders one list item per step with a numbered indicator', () => {
		render(
			<ConnectStepper
				steps={[
					{ label: 'API key', status: 'active' },
					{ label: 'Domain', status: 'pending' },
					{ label: 'DNS + webhook', status: 'pending' },
					{ label: 'Done', status: 'pending' },
				]}
			/>,
		)
		expect(screen.getByRole('list', { name: /connection progress/i })).toBeInTheDocument()
		expect(screen.getAllByRole('listitem')).toHaveLength(4)
	})

	it('sets aria-current="step" on the active step and nowhere else', () => {
		render(
			<ConnectStepper
				steps={[
					{ label: 'API key', status: 'done' },
					{ label: 'Domain', status: 'active' },
					{ label: 'DNS + webhook', status: 'pending' },
					{ label: 'Done', status: 'pending' },
				]}
			/>,
		)
		const items = screen.getAllByRole('listitem')
		expect(items[0].getAttribute('aria-current')).toBeNull()
		expect(items[1].getAttribute('aria-current')).toBe('step')
		expect(items[2].getAttribute('aria-current')).toBeNull()
	})

	it('announces status per step for screen readers', () => {
		render(
			<ConnectStepper
				steps={[
					{ label: 'API key', status: 'done' },
					{ label: 'Domain', status: 'active' },
					{ label: 'DNS + webhook', status: 'pending' },
					{ label: 'Done', status: 'pending' },
				]}
			/>,
		)
		expect(screen.getByText(/Step 1 of 4: API key, completed/)).toBeInTheDocument()
		expect(screen.getByText(/Step 2 of 4: Domain, active/)).toBeInTheDocument()
		expect(screen.getByText(/Step 3 of 4: DNS \+ webhook, not started/)).toBeInTheDocument()
	})
})
