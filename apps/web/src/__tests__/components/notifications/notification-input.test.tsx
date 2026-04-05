import { NotificationInput } from '@/components/notifications/notification-input'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('NotificationInput', () => {
	describe('single_choice', () => {
		const metadata = {
			input_type: 'single_choice',
			question: 'Pick one',
			options: [
				{ label: 'Alpha', value: 'alpha' },
				{ label: 'Beta', value: 'beta' },
			],
		}

		it('renders radio options', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()
		})

		it('renders question text', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByText('Pick one')).toBeInTheDocument()
		})

		it('confirm button disabled until selection', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
		})

		it('submits selected value', async () => {
			const user = userEvent.setup()
			const onSubmit = vi.fn()
			render(<NotificationInput metadata={metadata} onSubmit={onSubmit} />)

			await user.click(screen.getByText('Alpha'))
			await user.click(screen.getByRole('button', { name: 'Confirm' }))
			expect(onSubmit).toHaveBeenCalledWith('alpha')
		})
	})

	describe('multiple_choice', () => {
		const metadata = {
			input_type: 'multiple_choice',
			options: [
				{ label: 'One', value: '1' },
				{ label: 'Two', value: '2' },
				{ label: 'Three', value: '3' },
			],
		}

		it('renders checkboxes', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByText('One')).toBeInTheDocument()
			expect(screen.getByText('Two')).toBeInTheDocument()
			expect(screen.getByText('Three')).toBeInTheDocument()
		})

		it('confirm button disabled until selection', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
		})

		it('submits array of selected values', async () => {
			const user = userEvent.setup()
			const onSubmit = vi.fn()
			render(<NotificationInput metadata={metadata} onSubmit={onSubmit} />)

			await user.click(screen.getByText('One'))
			await user.click(screen.getByText('Three'))
			await user.click(screen.getByRole('button', { name: 'Confirm' }))
			expect(onSubmit).toHaveBeenCalledWith(expect.arrayContaining(['1', '3']))
		})
	})

	describe('text', () => {
		it('renders text input', () => {
			const metadata = { input_type: 'text' }
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByPlaceholderText('Type your response...')).toBeInTheDocument()
		})

		it('renders custom placeholder', () => {
			const metadata = { input_type: 'text', placeholder: 'Enter details' }
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByPlaceholderText('Enter details')).toBeInTheDocument()
		})

		it('submit button disabled when empty', () => {
			const metadata = { input_type: 'text' }
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
		})

		it('submits text value', async () => {
			const user = userEvent.setup()
			const onSubmit = vi.fn()
			const metadata = { input_type: 'text' }
			render(<NotificationInput metadata={metadata} onSubmit={onSubmit} />)

			await user.type(screen.getByPlaceholderText('Type your response...'), 'hello world')
			await user.click(screen.getByRole('button', { name: 'Submit' }))
			expect(onSubmit).toHaveBeenCalledWith('hello world')
		})

		it('renders textarea for multiline text', () => {
			const metadata = { input_type: 'text', multiline: true }
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			const textarea = screen.getByPlaceholderText('Type your response...')
			expect(textarea.tagName).toBe('TEXTAREA')
		})
	})

	describe('confirmation', () => {
		const metadata = { input_type: 'confirmation' }

		it('renders Yes and No buttons', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument()
		})

		it('submits true on Yes click', async () => {
			const user = userEvent.setup()
			const onSubmit = vi.fn()
			render(<NotificationInput metadata={metadata} onSubmit={onSubmit} />)

			await user.click(screen.getByRole('button', { name: 'Yes' }))
			expect(onSubmit).toHaveBeenCalledWith(true)
		})

		it('submits false on No click', async () => {
			const user = userEvent.setup()
			const onSubmit = vi.fn()
			render(<NotificationInput metadata={metadata} onSubmit={onSubmit} />)

			await user.click(screen.getByRole('button', { name: 'No' }))
			expect(onSubmit).toHaveBeenCalledWith(false)
		})

		it('shows "Confirmation" heading', () => {
			render(<NotificationInput metadata={metadata} onSubmit={vi.fn()} />)
			expect(screen.getByText('Confirmation')).toBeInTheDocument()
		})
	})
})
