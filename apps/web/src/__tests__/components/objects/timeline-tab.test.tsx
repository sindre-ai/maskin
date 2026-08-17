import { TimelineTab } from '@/components/objects/timeline-tab'
import { useObjectGraph } from '@/hooks/use-objects'
import { render, screen, within } from '@testing-library/react'
import { buildEventResponse, buildObjectResponse, buildRelationshipResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-objects', () => ({
	useObjectGraph: vi.fn(),
	useObject: () => ({ data: undefined, isLoading: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'actor-1', name: 'Ada', type: 'human' },
			{ id: 'actor-2', name: 'Agent Smith', type: 'agent' },
		],
	}),
	useActor: () => ({ data: undefined }),
}))

function mockGraph(
	events: ReturnType<typeof buildEventResponse>[],
	relationships: ReturnType<typeof buildRelationshipResponse>[] = [],
	connectedObjects: ReturnType<typeof buildObjectResponse>[] = [],
	object = buildObjectResponse({}),
) {
	vi.mocked(useObjectGraph).mockReturnValue({
		data: { object, relationships, connected_objects: connectedObjects, events },
	} as never)
}

describe('TimelineTab', () => {
	it('renders entries with time, who, text, chip, and an object reference with a verb', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet', title: 'Root bet' })
		const target = buildObjectResponse({ id: 'obj-2', type: 'task', title: 'Timeline tab' })
		const events = [
			buildEventResponse({
				id: 3,
				action: 'status_changed',
				entityType: 'bet',
				entityId: 'obj-1',
				actorId: 'actor-1',
				createdAt: '2026-01-03T00:00:00Z',
				data: {
					changes: [{ field: 'status', old: 'define', new: 'active' }],
				},
			}),
			buildEventResponse({
				id: 2,
				action: 'created',
				entityType: 'task',
				entityId: 'obj-2',
				actorId: 'actor-2',
				createdAt: '2026-01-02T00:00:00Z',
			}),
		]
		const relationships = [
			buildRelationshipResponse({
				id: 'rel-1',
				sourceId: 'obj-1',
				sourceType: 'bet',
				targetId: 'obj-2',
				targetType: 'task',
				targetTitle: 'Timeline tab',
				type: 'breaks_into',
				createdBy: 'actor-2',
				createdAt: '2026-01-01T00:00:00Z',
			}),
		]
		mockGraph(events, relationships, [target], object)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(3)

		// Newest first — status change on the page's own object leads and has no
		// reference card (would duplicate the page header).
		const [first, second, third] = items
		expect(within(first).getByText('Ada')).toBeInTheDocument()
		expect(within(first).getByText(/changed status from Define to Active/i)).toBeInTheDocument()
		expect(within(first).getByText('Status')).toBeInTheDocument()

		// Second row — created event points at the child task, verb + reference
		// card render together.
		expect(within(second).getByText('Agent Smith')).toBeInTheDocument()
		expect(within(second).getByText('created task')).toBeInTheDocument()
		expect(within(second).getByText('Created')).toBeInTheDocument()
		expect(within(second).getByText('on')).toBeInTheDocument()
		expect(within(second).getByRole('link', { name: /Timeline tab/i })).toBeInTheDocument()

		// Third row — relationship: verb + object reference.
		expect(within(third).getByText('Agent Smith')).toBeInTheDocument()
		expect(within(third).getByText('Link')).toBeInTheDocument()
		expect(within(third).getByText('breaks into')).toBeInTheDocument()
		expect(within(third).getAllByRole('link', { name: /Timeline tab/i })).not.toHaveLength(0)
	})

	it('omits comment events (they live in the Activity tab)', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			[
				buildEventResponse({
					id: 5,
					action: 'commented',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-05T00:00:00Z',
				}),
				buildEventResponse({
					id: 4,
					action: 'status_changed',
					entityType: 'bet',
					entityId: 'obj-1',
					actorId: 'actor-1',
					createdAt: '2026-01-04T00:00:00Z',
					data: { changes: [{ field: 'status', old: 'define', new: 'active' }] },
				}),
			],
			[],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(1)
		expect(within(items[0]).getByText('Status')).toBeInTheDocument()
		expect(screen.queryByText(/commented/i)).not.toBeInTheDocument()
	})

	it('sorts entries newest first regardless of arrival order', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			[
				buildEventResponse({
					id: 1,
					action: 'session_completed',
					entityType: 'bet',
					entityId: 'obj-1',
					actorId: 'actor-2',
					createdAt: '2026-01-02T00:00:00Z',
				}),
				buildEventResponse({
					id: 2,
					action: 'created',
					entityType: 'bet',
					entityId: 'obj-1',
					actorId: 'actor-1',
					createdAt: '2026-01-04T00:00:00Z',
				}),
				buildEventResponse({
					id: 3,
					action: 'status_changed',
					entityType: 'bet',
					entityId: 'obj-1',
					actorId: 'actor-1',
					createdAt: '2026-01-03T00:00:00Z',
					data: { changes: [{ field: 'status', old: 'define', new: 'active' }] },
				}),
			],
			[],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(3)
		expect(within(items[0]).getByText('Created')).toBeInTheDocument()
		expect(within(items[1]).getByText('Status')).toBeInTheDocument()
		expect(within(items[2]).getByText('Session')).toBeInTheDocument()
	})

	it('renders an empty state when there is nothing to show', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph([], [], [], object)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
		expect(screen.getByText('No timeline entries yet')).toBeInTheDocument()
	})

	it('falls back to a denormalized title when the linked object is not in the graph', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			[],
			[
				buildRelationshipResponse({
					id: 'rel-1',
					sourceId: 'obj-1',
					sourceType: 'bet',
					targetId: 'obj-99',
					targetType: 'task',
					targetTitle: 'Ghost task',
					type: 'relates_to',
					createdBy: 'actor-1',
					createdAt: '2026-01-01T00:00:00Z',
				}),
			],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('relates to')).toBeInTheDocument()
		expect(screen.getByText('Ghost task')).toBeInTheDocument()
	})
})
