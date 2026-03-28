import { PulseCard } from '@/components/pulse/pulse-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorListItem, buildNotificationResponse } from '../../factories'

describe('PulseCard', () => {
	const actorsById = new Map([['actor-1', buildActorListItem({ id: 'actor-1', name: 'Bot' })]])

	it('renders notification title', () => {
		const notification = buildNotificationResponse({ title: 'New Pattern' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('New Pattern')).toBeInTheDocument()
	})

	it('renders notification content', () => {
		const notification = buildNotificationResponse({ content: 'Details here' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('Details here')).toBeInTheDocument()
	})

	it('shows type label badge', () => {
		const notification = buildNotificationResponse({ type: 'recommendation' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('Pattern detected')).toBeInTheDocument()
	})

	it('shows urgency label when present', () => {
		const notification = buildNotificationResponse({
			metadata: { urgency_label: 'Critical' },
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('Critical')).toBeInTheDocument()
	})

	it('shows tags', () => {
		const notification = buildNotificationResponse({
			metadata: { tags: ['bug', 'performance'] },
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('bug')).toBeInTheDocument()
		expect(screen.getByText('performance')).toBeInTheDocument()
	})

	it('shows agent suggestion', () => {
		const notification = buildNotificationResponse({
			metadata: { suggestion: 'Consider upgrading' },
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('Consider upgrading')).toBeInTheDocument()
	})

	it('shows Dismiss button', () => {
		const notification = buildNotificationResponse()
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
	})

	it('calls onDismiss when Dismiss clicked', async () => {
		const user = userEvent.setup()
		const onDismiss = vi.fn()
		const notification = buildNotificationResponse({ id: 'n-1' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={onDismiss}
			/>,
		)

		await user.click(screen.getByRole('button', { name: 'Dismiss' }))
		expect(onDismiss).toHaveBeenCalledWith('n-1')
	})

	it('shows Create bet and Show data for recommendation type', () => {
		const notification = buildNotificationResponse({ type: 'recommendation' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByRole('button', { name: 'Create bet' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Show data' })).toBeInTheDocument()
	})

	it('shows Review tasks for alert type', () => {
		const notification = buildNotificationResponse({ type: 'alert' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByRole('button', { name: 'Review tasks' })).toBeInTheDocument()
	})

	it('shows source actor name when available', () => {
		const notification = buildNotificationResponse({ sourceActorId: 'actor-1' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onRespond={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByText('Bot')).toBeInTheDocument()
	})
})
