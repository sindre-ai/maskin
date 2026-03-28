import { ObjectActivity } from '@/components/activity/object-activity'
import { render, screen } from '@testing-library/react'
import { buildEventResponse } from '../../factories'

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

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: React.ReactNode }) => <a href="/mock">{children}</a>,
	useNavigate: () => vi.fn(),
}))

describe('ObjectActivity', () => {
	it('shows "No activity yet" when events is empty', () => {
		render(<ObjectActivity workspaceId="ws-1" objectId="obj-1" events={[]} />)
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('shows "No activity yet" when events is undefined', () => {
		render(<ObjectActivity workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('shows Activity heading', () => {
		render(<ObjectActivity workspaceId="ws-1" objectId="obj-1" events={[]} />)
		expect(screen.getByText('Activity')).toBeInTheDocument()
	})

	it('renders system events as ActivityItem', () => {
		const events = [buildEventResponse({ id: 1, action: 'created', entityType: 'bet' })]
		render(<ObjectActivity workspaceId="ws-1" objectId="obj-1" events={events} />)
		expect(screen.getByText('proposed bet')).toBeInTheDocument()
	})

	it('renders comments separately from system events', () => {
		const events = [
			buildEventResponse({
				id: 1,
				action: 'commented',
				data: { content: 'Great work!' },
			}),
			buildEventResponse({ id: 2, action: 'updated', entityType: 'bet' }),
		]
		render(<ObjectActivity workspaceId="ws-1" objectId="obj-1" events={events} />)
		expect(screen.getByText('Great work!')).toBeInTheDocument()
		expect(screen.getByText('updated bet')).toBeInTheDocument()
	})

	it('shows comment input', () => {
		render(<ObjectActivity workspaceId="ws-1" objectId="obj-1" events={[]} />)
		expect(screen.getByPlaceholderText('Comment or instruct an agent...')).toBeInTheDocument()
	})
})
