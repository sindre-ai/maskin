import { ObjectActivity } from '@/components/activity/object-activity'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildEventResponse, buildObjectResponse } from '../../factories'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: undefined }),
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
	useEditComment: () => ({ mutate: vi.fn(), isPending: false }),
	useDeleteComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useMarkRead: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-event-visible', () => ({
	useEventVisible: () => ({ current: null }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useMentionSessionsForObject: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-files', () => ({
	useFiles: () => ({ data: [] }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Me', type: 'human' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const object = buildObjectResponse({ id: 'obj-1', status: 'signal' })

describe('ObjectActivity', () => {
	it('shows "No activity yet" when events is empty', () => {
		render(<ObjectActivity workspaceId="ws-1" object={object} events={[]} />)
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('shows "No activity yet" when events is undefined', () => {
		render(<ObjectActivity workspaceId="ws-1" object={object} />)
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('shows Activity heading', () => {
		render(<ObjectActivity workspaceId="ws-1" object={object} events={[]} />)
		expect(screen.getByText('Activity')).toBeInTheDocument()
	})

	it('renders system events as ActivityItem', () => {
		const events = [buildEventResponse({ id: 1, action: 'created', entityType: 'bet' })]
		render(<ObjectActivity workspaceId="ws-1" object={object} events={events} />)
		expect(screen.getByText('proposed bet')).toBeInTheDocument()
	})

	it('renders comments and system events together within their phase', () => {
		const events = [
			buildEventResponse({
				id: 1,
				action: 'commented',
				data: { content: 'Great work!' },
			}),
			buildEventResponse({ id: 2, action: 'updated', entityType: 'bet' }),
		]
		render(<ObjectActivity workspaceId="ws-1" object={object} events={events} />)
		expect(screen.getByText('Great work!')).toBeInTheDocument()
		expect(screen.getByText('updated bet')).toBeInTheDocument()
	})

	it('shows comment input', () => {
		render(<ObjectActivity workspaceId="ws-1" object={object} events={[]} />)
		expect(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
		).toBeInTheDocument()
	})

	it('renders a phase divider for each status the object has been in', () => {
		const events = [
			buildEventResponse({
				id: 1,
				action: 'status_changed',
				data: { previous: { status: 'signal' }, updated: { status: 'active' } },
			}),
		]
		render(<ObjectActivity workspaceId="ws-1" object={object} events={events} />)
		expect(screen.getByText('active')).toBeInTheDocument()
		expect(screen.getByText('set the status to Active')).toBeInTheDocument()
	})

	it('collapses past phases and only expands the current phase by default', () => {
		// Events arrive from the API newest-first
		const events = [
			buildEventResponse({
				id: 3,
				action: 'commented',
				data: { content: 'Comment in active phase' },
			}),
			buildEventResponse({
				id: 2,
				action: 'status_changed',
				data: { previous: { status: 'signal' }, updated: { status: 'active' } },
			}),
			buildEventResponse({
				id: 1,
				action: 'commented',
				data: { content: 'Comment in signal phase' },
			}),
		]
		render(<ObjectActivity workspaceId="ws-1" object={object} events={events} />)

		// Current (active) phase content is visible
		expect(screen.getByText('Comment in active phase')).toBeInTheDocument()
		// Past (signal) phase content is collapsed and shows event count summary
		expect(screen.queryByText('Comment in signal phase')).not.toBeInTheDocument()
		expect(screen.getByText('· 1 event')).toBeInTheDocument()
	})

	it('hides comments that have a comment_deleted sibling event on the same entity', () => {
		const events = [
			buildEventResponse({
				id: 10,
				action: 'commented',
				data: { content: 'Still here' },
			}),
			buildEventResponse({
				id: 11,
				action: 'commented',
				data: { content: 'Was deleted' },
			}),
			buildEventResponse({
				id: 12,
				action: 'comment_deleted',
				data: { originalEventId: 11, deletedAt: '2026-06-11T12:00:00Z' },
			}),
		]
		render(<ObjectActivity workspaceId="ws-1" object={object} events={events} />)

		expect(screen.getByText('Still here')).toBeInTheDocument()
		// The soft-deleted comment is hidden by the read-time join, and the
		// `comment_deleted` audit row never renders as a timeline item.
		expect(screen.queryByText('Was deleted')).not.toBeInTheDocument()
	})

	it('expands a past phase when its divider is clicked', async () => {
		const user = userEvent.setup()
		const events = [
			buildEventResponse({
				id: 2,
				action: 'status_changed',
				data: { previous: { status: 'signal' }, updated: { status: 'active' } },
			}),
			buildEventResponse({
				id: 1,
				action: 'commented',
				data: { content: 'Comment in signal phase' },
			}),
		]
		render(<ObjectActivity workspaceId="ws-1" object={object} events={events} />)

		expect(screen.queryByText('Comment in signal phase')).not.toBeInTheDocument()

		const signalTrigger = screen.getByRole('button', { name: /signal/ })
		await user.click(signalTrigger)

		expect(screen.getByText('Comment in signal phase')).toBeInTheDocument()
	})
})
