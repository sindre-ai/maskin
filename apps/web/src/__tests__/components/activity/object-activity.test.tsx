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

	it('renders all phases expanded by default', () => {
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

		// Both current and past phase content is visible by default
		expect(screen.getByText('Comment in active phase')).toBeInTheDocument()
		expect(screen.getByText('Comment in signal phase')).toBeInTheDocument()
	})

	it('collapses a phase when its divider is clicked', async () => {
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

		// Past phase content is visible by default
		expect(screen.getByText('Comment in signal phase')).toBeInTheDocument()

		// Clicking the phase divider toggles it closed
		const signalTrigger = screen.getByRole('button', { name: /signal/ })
		await user.click(signalTrigger)

		expect(screen.queryByText('Comment in signal phase')).not.toBeInTheDocument()
	})
})
