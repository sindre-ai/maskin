import { ActivityItemView } from '@/components/activity/activity-item'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse, buildEventResponse } from '../../factories'

describe('ActivityItemView', () => {
	it('renders actor name and event description', () => {
		const actor = buildActorResponse({ name: 'Alice' })
		const event = buildEventResponse({ action: 'created', entityType: 'bet' })

		render(<ActivityItemView event={event} actor={actor} />)

		expect(screen.getByText('Alice')).toBeInTheDocument()
		expect(screen.getByText('proposed bet')).toBeInTheDocument()
	})

	it('shows "Unknown" when actor is undefined', () => {
		const event = buildEventResponse({ action: 'created', entityType: 'insight' })

		render(<ActivityItemView event={event} />)

		expect(screen.getByText('Unknown')).toBeInTheDocument()
	})

	it('shows entity title when present in event data', () => {
		const actor = buildActorResponse()
		const event = buildEventResponse({ data: { title: 'My Bet' } })

		render(<ActivityItemView event={event} actor={actor} />)

		expect(screen.getByText('My Bet')).toBeInTheDocument()
	})

	it('shows entity title from nested updated data', () => {
		const actor = buildActorResponse()
		const event = buildEventResponse({
			action: 'updated',
			data: { updated: { title: 'Updated Title' } },
		})

		render(<ActivityItemView event={event} actor={actor} />)

		expect(screen.getByText('Updated Title')).toBeInTheDocument()
	})

	it('shows error badge for failed events', () => {
		const actor = buildActorResponse()
		const event = buildEventResponse({ action: 'session_failed' })

		render(<ActivityItemView event={event} actor={actor} />)

		expect(screen.getByText('error')).toBeInTheDocument()
	})

	it('does not show error badge for normal events', () => {
		const actor = buildActorResponse()
		const event = buildEventResponse({ action: 'created' })

		render(<ActivityItemView event={event} actor={actor} />)

		expect(screen.queryByText('error')).not.toBeInTheDocument()
	})

	it('renders entity title as button when onNavigate is provided', async () => {
		const user = userEvent.setup()
		const actor = buildActorResponse()
		const event = buildEventResponse({
			entityId: 'obj-1',
			workspaceId: 'ws-1',
			data: { title: 'Clickable' },
		})
		const onNavigate = vi.fn()

		render(<ActivityItemView event={event} actor={actor} onNavigate={onNavigate} />)

		await user.click(screen.getByText('Clickable'))
		expect(onNavigate).toHaveBeenCalledWith('ws-1', 'obj-1')
	})

	it('applies reduced opacity for agent actors', () => {
		const agent = buildActorResponse({ type: 'agent', name: 'Bot' })
		const event = buildEventResponse()

		const { container } = render(<ActivityItemView event={event} actor={agent} />)

		expect(container.firstChild).toHaveClass('opacity-75')
	})
})
