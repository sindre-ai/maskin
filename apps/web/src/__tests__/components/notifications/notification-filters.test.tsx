import { NotificationFilters } from '@/components/notifications/notification-filters'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('NotificationFilters', () => {
	const counts = { all: 12, needs_input: 3, recommendation: 4, good_news: 3, alert: 2 }

	it('renders all filter buttons with labels and counts', () => {
		render(<NotificationFilters active="all" onChange={vi.fn()} counts={counts} />)
		expect(screen.getByText('All 12')).toBeInTheDocument()
		expect(screen.getByText('Needs you 3')).toBeInTheDocument()
		expect(screen.getByText('Recommendations 4')).toBeInTheDocument()
		expect(screen.getByText('Good news 3')).toBeInTheDocument()
		expect(screen.getByText('Alerts 2')).toBeInTheDocument()
	})

	it('shows 0 count for missing filter values', () => {
		render(<NotificationFilters active="all" onChange={vi.fn()} counts={{ all: 5 }} />)
		expect(screen.getByText('Needs you 0')).toBeInTheDocument()
	})

	it('calls onChange with correct value on click', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<NotificationFilters active="all" onChange={onChange} counts={counts} />)

		await user.click(screen.getByText('Needs you 3'))
		expect(onChange).toHaveBeenCalledWith('needs_input')
	})
})
