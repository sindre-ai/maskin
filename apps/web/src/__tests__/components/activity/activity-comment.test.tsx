import { ActivityComment } from '@/components/activity/activity-comment'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildEventResponse } from '../../factories'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({
		data: { id: 'actor-1', name: 'Alice', type: 'human', email: null },
	}),
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Alice', type: 'human' }),
}))

describe('ActivityComment', () => {
	it('renders actor name', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Hello' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	it('renders comment content', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'This looks good' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('This looks good')).toBeInTheDocument()
	})

	it('renders @mentions as styled chips', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Hey @Bob what do you think?' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('@Bob')).toBeInTheDocument()
	})

	it('shows reply count and toggle', () => {
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread starter' },
		})
		const replies = [
			buildEventResponse({
				id: 2,
				action: 'commented',
				data: { content: 'Reply one', parentEventId: 1 },
			}),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		expect(screen.getByText('1 reply')).toBeInTheDocument()
	})

	it('shows plural reply count', () => {
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread' },
		})
		const replies = [
			buildEventResponse({ id: 2, action: 'commented', data: { content: 'R1' } }),
			buildEventResponse({ id: 3, action: 'commented', data: { content: 'R2' } }),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		expect(screen.getByText('2 replies')).toBeInTheDocument()
	})

	it('shows Reply button', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('Reply')).toBeInTheDocument()
	})

	it('shows reply input on Reply click', async () => {
		const user = userEvent.setup()
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByText('Reply'))
		expect(
			screen.getAllByPlaceholderText('Comment or instruct an agent...').length,
		).toBeGreaterThanOrEqual(1)
	})
})
