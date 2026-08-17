import { ActivityTab } from '@/components/objects/activity-tab'
import { useObjectGraph } from '@/hooks/use-objects'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildEventResponse, buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-objects', () => ({
	useObjectGraph: vi.fn(),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
	useActor: () => ({ data: undefined }),
}))

// Keep the test focused on ActivityTab's own logic (filtering, counts, unread
// jump) by stubbing the shared renderers — they have their own tests.
vi.mock('@/components/activity/activity-item', () => ({
	ActivityItem: ({ event }: { event: { id: number; action: string } }) => (
		<div>
			item:{event.id}:{event.action}
		</div>
	),
}))

vi.mock('@/components/activity/activity-comment', () => ({
	ActivityComment: ({
		event,
		isUnread,
	}: {
		event: { id: number }
		isUnread?: boolean
	}) => (
		<div id={`comment-${event.id}`}>
			comment:{event.id}
			{isUnread ? ':unread' : ''}
		</div>
	),
}))

function mockGraph(
	events: ReturnType<typeof buildEventResponse>[],
	object = buildObjectResponse({}),
) {
	vi.mocked(useObjectGraph).mockReturnValue({
		data: { object, relationships: [], connected_objects: [], events },
	} as never)
}

describe('ActivityTab', () => {
	it('renders real activity events against the object', () => {
		const events = [
			buildEventResponse({ id: 3, action: 'commented', entityType: 'bet', entityId: 'obj-1' }),
			buildEventResponse({ id: 2, action: 'status_changed', entityType: 'bet', entityId: 'obj-1' }),
			buildEventResponse({ id: 1, action: 'created', entityType: 'bet', entityId: 'obj-1' }),
		]
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(events, object)

		render(<ActivityTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getAllByRole('listitem')).toHaveLength(3)
		expect(screen.getByText('comment:3')).toBeInTheDocument()
		expect(screen.getByText('item:2:status_changed')).toBeInTheDocument()
		expect(screen.getByText('item:1:created')).toBeInTheDocument()
	})

	it('renders per-filter counts and updates the visible list when a filter is selected', () => {
		const events = [
			buildEventResponse({ id: 3, action: 'commented', entityType: 'bet', entityId: 'obj-1' }),
			buildEventResponse({ id: 2, action: 'status_changed', entityType: 'bet', entityId: 'obj-1' }),
			buildEventResponse({ id: 1, action: 'created', entityType: 'bet', entityId: 'obj-1' }),
		]
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(events, object)

		render(<ActivityTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getAllByRole('listitem')).toHaveLength(3)
		expect(screen.getByRole('button', { name: 'All 3' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Comments 1' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Status 1' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Updates 1' })).toBeInTheDocument()

		fireEvent.click(screen.getByRole('button', { name: 'Comments 1' }))
		expect(screen.getAllByRole('listitem')).toHaveLength(1)
		expect(screen.getByText('comment:3')).toBeInTheDocument()
		expect(screen.queryByText('item:2:status_changed')).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole('button', { name: 'Status 1' }))
		expect(screen.getAllByRole('listitem')).toHaveLength(1)
		expect(screen.getByText('item:2:status_changed')).toBeInTheDocument()
		expect(screen.queryByText('comment:3')).not.toBeInTheDocument()
	})

	it('shows an empty state when the selected filter has no events', () => {
		const events = [
			buildEventResponse({ id: 2, action: 'status_changed', entityType: 'bet', entityId: 'obj-1' }),
		]
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(events, object)

		render(<ActivityTab object={object} />, { wrapper: createWorkspaceWrapper() })

		fireEvent.click(screen.getByRole('button', { name: 'Comments 0' }))
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('surfaces unread activity and jumps to the first unread comment', () => {
		const scrollIntoView = vi.fn()
		Element.prototype.scrollIntoView = scrollIntoView

		const events = [
			buildEventResponse({
				id: 30,
				action: 'status_changed',
				entityType: 'bet',
				entityId: 'obj-1',
			}),
			buildEventResponse({ id: 20, action: 'commented', entityType: 'bet', entityId: 'obj-1' }),
			buildEventResponse({ id: 10, action: 'commented', entityType: 'bet', entityId: 'obj-1' }),
		]
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet', unread_count: 2 })
		mockGraph(events, object)

		render(<ActivityTab object={object} />, { wrapper: createWorkspaceWrapper() })

		// Unread badge surfaces the unseen count; the two newest comments carry dots.
		expect(screen.getByLabelText('2 unread')).toBeInTheDocument()
		expect(screen.getByText('comment:20:unread')).toBeInTheDocument()
		expect(screen.getByText('comment:10:unread')).toBeInTheDocument()
		expect(screen.getByText('item:30:status_changed')).toBeInTheDocument()

		// Jump targets the first unread thread (lowest unread comment id = 10)
		// and scrolls to it after resetting the filter to All.
		fireEvent.click(screen.getByRole('button', { name: /jump to first unread/i }))
		expect(scrollIntoView).toHaveBeenCalledTimes(1)
		expect(screen.getAllByRole('listitem')).toHaveLength(3)
	})

	it('threads replies under their parent comment', () => {
		const events = [
			buildEventResponse({
				id: 4,
				action: 'commented',
				entityType: 'bet',
				entityId: 'obj-1',
				data: { parentEventId: 3 },
			}),
			buildEventResponse({ id: 3, action: 'commented', entityType: 'bet', entityId: 'obj-1' }),
			buildEventResponse({ id: 2, action: 'created', entityType: 'bet', entityId: 'obj-1' }),
		]
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(events, object)

		render(<ActivityTab object={object} />, { wrapper: createWorkspaceWrapper() })

		// Reply (id 4) is bucketed under the parent — the list shows one top-level
		// comment row plus the created event.
		expect(screen.getAllByRole('listitem')).toHaveLength(2)
		expect(screen.getByText('comment:3')).toBeInTheDocument()
		expect(screen.queryByText('comment:4')).not.toBeInTheDocument()
		expect(screen.getByText('item:2:created')).toBeInTheDocument()
	})
})
