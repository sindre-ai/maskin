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

	it('renders replies inline without a toggle', () => {
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

		expect(screen.getByText('Reply one')).toBeInTheDocument()
	})

	it('renders multiple replies inline', () => {
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

		expect(screen.getByText('R1')).toBeInTheDocument()
		expect(screen.getByText('R2')).toBeInTheDocument()
	})

	it('shows a Reply action button on the top-level comment when there are no replies', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument()
	})

	it('shows the Reply action button only on the last reply when replies exist', () => {
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

		expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1)
	})

	it('shows reply input on Reply click', async () => {
		const user = userEvent.setup()
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByRole('button', { name: 'Reply' }))
		expect(
			screen.getAllByPlaceholderText('Write a comment... Use @ to mention an agent').length,
		).toBeGreaterThanOrEqual(1)
	})

	it('clicking Reply on the last reply opens the input on the parent thread', async () => {
		const user = userEvent.setup()
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread' },
		})
		const replies = [
			buildEventResponse({
				id: 2,
				action: 'commented',
				data: { content: 'R1', parentEventId: 1 },
			}),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByRole('button', { name: 'Reply' }))

		expect(
			screen.getAllByPlaceholderText('Write a comment... Use @ to mention an agent').length,
		).toBeGreaterThanOrEqual(1)
	})
})
