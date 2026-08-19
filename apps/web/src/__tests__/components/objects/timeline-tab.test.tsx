import { TimelineTab } from '@/components/objects/timeline-tab'
import { useObjectGraph } from '@/hooks/use-objects'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
		// Only a status move carries a chip, and it names the new status.
		expect(within(first).getByText('active')).toBeInTheDocument()

		// Second row — created event points at the child task, verb + reference
		// card render together.
		expect(within(second).getByText('Agent Smith')).toBeInTheDocument()
		expect(within(second).getByText('created task')).toBeInTheDocument()
		expect(within(second).queryByText('Created')).toBeNull()
		expect(within(second).getByText('on')).toBeInTheDocument()
		expect(within(second).getByRole('link', { name: /Timeline tab/i })).toBeInTheDocument()

		// Third row — relationship: verb + object reference, no actor sentence.
		expect(within(third).queryByText('Agent Smith')).toBeNull()
		expect(within(third).queryByText('Link')).toBeNull()
		expect(within(third).getByText('breaks into')).toBeInTheDocument()
		expect(within(third).getAllByRole('link', { name: /Timeline tab/i })).not.toHaveLength(0)
	})

	// The Activity/Timeline split is gone: one stream carries comments and
	// events together (mockup 1176–1355).
	it('renders comment events inline in the same stream as events', () => {
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
		expect(items).toHaveLength(2)
		expect(within(items[1]).getByText('active')).toBeInTheDocument()
		// Filter chips carry per-kind counts (mockup 1145–1152).
		expect(screen.getByRole('button', { name: 'Comments (1)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Changes (1)' })).toBeInTheDocument()
	})

	it('narrows the stream to one kind when a filter chip is picked, and resets', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			[
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

		await user.click(screen.getByRole('button', { name: 'Comments (0)' }))
		expect(screen.queryByRole('listitem')).toBeNull()
		await user.click(screen.getByRole('button', { name: 'Show all activity' }))
		expect(screen.getAllByRole('listitem')).toHaveLength(1)
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
		expect(within(items[0]).getByText('proposed bet')).toBeInTheDocument()
		expect(within(items[1]).getByText('active')).toBeInTheDocument()
		expect(within(items[2]).getByText(/session/i)).toBeInTheDocument()
	})

	it('renders an empty state when there is nothing to show', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph([], [], [], object)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
		expect(screen.getByText('No activity yet.')).toBeInTheDocument()
	})

	// Loading → error → empty: a pending or failed graph fetch has the same
	// empty `events` array as a genuinely quiet object and must not claim
	// "No activity yet."
	it('shows a skeleton instead of the empty state while the graph is loading', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		vi.mocked(useObjectGraph).mockReturnValue({ data: undefined, isLoading: true } as never)

		const { container } = render(<TimelineTab object={object} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(screen.queryByText('No activity yet.')).not.toBeInTheDocument()
		expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
	})

	it('shows an error card instead of the empty state when the graph fetch fails', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		vi.mocked(useObjectGraph).mockReturnValue({
			data: undefined,
			isError: true,
			error: new Error('boom'),
		} as never)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByText('No activity yet.')).not.toBeInTheDocument()
		expect(screen.getByText("Couldn't load activity")).toBeInTheDocument()
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
	// Migrated from the retired ActivityTab: the merged stream owns unread
	// surfacing and comment threading now.
	it('surfaces unread activity, jumps to the first unread comment, and can mark it read', async () => {
		const user = userEvent.setup()
		const scrollIntoView = vi.fn()
		Element.prototype.scrollIntoView = scrollIntoView

		const object = buildObjectResponse({ id: 'obj-1', type: 'bet', unread_count: 2 })
		mockGraph(
			[
				buildEventResponse({
					id: 30,
					action: 'status_changed',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-03T00:00:00Z',
					data: { changes: [{ field: 'status', old: 'define', new: 'active' }] },
				}),
				buildEventResponse({
					id: 20,
					action: 'commented',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-02T00:00:00Z',
				}),
				buildEventResponse({
					id: 10,
					action: 'commented',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-01T00:00:00Z',
				}),
			],
			[],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getAllByRole('listitem')).toHaveLength(3)
		await user.click(screen.getByRole('button', { name: /2 new updates/ }))
		expect(scrollIntoView).toHaveBeenCalledTimes(1)

		await user.click(screen.getByRole('button', { name: 'Mark read' }))
		expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull()
	})

	it('threads replies under their parent comment instead of listing them', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			[
				buildEventResponse({
					id: 4,
					action: 'commented',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-04T00:00:00Z',
					data: { parentEventId: 3 },
				}),
				buildEventResponse({
					id: 3,
					action: 'commented',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-03T00:00:00Z',
				}),
				buildEventResponse({
					id: 2,
					action: 'created',
					entityType: 'bet',
					entityId: 'obj-1',
					createdAt: '2026-01-02T00:00:00Z',
				}),
			],
			[],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getAllByRole('listitem')).toHaveLength(2)
	})
	// Mockup 1205–1219: a run of routine machine chatter collapses behind one
	// dashed pill; comments and status changes are never folded away.
	it('folds a run of routine updates and expands it in place', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			Array.from({ length: 5 }, (_, i) =>
				buildEventResponse({
					id: 10 + i,
					action: 'updated',
					entityType: 'bet',
					entityId: 'obj-1',
					actorId: 'actor-1',
					createdAt: `2026-01-0${i + 1}T00:00:00Z`,
				}),
			),
			[],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByRole('listitem')).not.toBeNull()
		const fold = screen.getByRole('button', { name: /5 agent updates/ })
		expect(fold).toHaveAttribute('aria-expanded', 'false')

		await user.click(fold)
		expect(screen.getByRole('button', { name: /Hide/ })).toHaveAttribute('aria-expanded', 'true')
		expect(screen.getAllByRole('listitem')).not.toHaveLength(0)
	})

	it('leaves short runs unfolded', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet' })
		mockGraph(
			Array.from({ length: 2 }, (_, i) =>
				buildEventResponse({
					id: 20 + i,
					action: 'updated',
					entityType: 'bet',
					entityId: 'obj-1',
					actorId: 'actor-1',
					createdAt: `2026-02-0${i + 1}T00:00:00Z`,
				}),
			),
			[],
			[],
			object,
		)

		render(<TimelineTab object={object} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByRole('button', { name: /agent updates/ })).toBeNull()
		expect(screen.getAllByRole('listitem')).toHaveLength(2)
	})
})
