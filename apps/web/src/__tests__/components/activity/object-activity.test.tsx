import { ObjectActivity } from '@/components/activity/object-activity'
import { render, screen } from '@testing-library/react'
import { buildEventResponse, buildObjectResponse } from '../../factories'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: undefined }),
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
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
		expect(screen.getByPlaceholderText('Comment or instruct an agent...')).toBeInTheDocument()
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
})
