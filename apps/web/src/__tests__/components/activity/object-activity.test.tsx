import { ObjectActivity } from '@/components/activity/object-activity'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildEventResponse, buildObjectResponse, buildRelationshipResponse } from '../../factories'

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

vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: null }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn(), isPending: false }),
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

	describe('relationships projection (AC-U11)', () => {
		// All three tests below pin the projection to relationships.created_at
		// (AC-T6), not the linked object's createdAt — covers the "linked
		// retroactively" case the Architect signed off on.
		const bet = buildObjectResponse({ id: 'bet-1', status: 'active', type: 'bet' })

		it('renders a linked object as a timeline row in Timeline view', () => {
			const linked = buildObjectResponse({ id: 'obj-link', title: 'Linked Insight' })
			const rel = buildRelationshipResponse({
				id: 'rel-1',
				sourceId: 'bet-1',
				targetId: 'obj-link',
				type: 'informs',
				createdAt: '2026-06-23T10:00:00Z',
			})
			render(
				<ObjectActivity
					workspaceId="ws-1"
					object={bet}
					events={[]}
					relationships={[rel]}
					connectedObjects={[linked]}
				/>,
			)
			expect(screen.getByText('Linked Insight')).toBeInTheDocument()
		})

		it('projects relationships at edge.createdAt, not linked.createdAt (AC-T6)', () => {
			// The linked insight was created earlier than the bet, but linked
			// later — the row must land at the link time, inside the current
			// active phase, not before the bet exists.
			const linked = buildObjectResponse({
				id: 'obj-link',
				title: 'Older Insight',
				createdAt: '2020-01-01T00:00:00Z',
			})
			const events = [
				buildEventResponse({
					id: 2,
					action: 'status_changed',
					createdAt: '2026-06-22T00:00:00Z',
					data: { previous: { status: 'signal' }, updated: { status: 'active' } },
				}),
			]
			const rel = buildRelationshipResponse({
				id: 'rel-late',
				sourceId: 'bet-1',
				targetId: 'obj-link',
				type: 'informs',
				createdAt: '2026-06-24T10:00:00Z',
			})
			render(
				<ObjectActivity
					workspaceId="ws-1"
					object={bet}
					events={events}
					relationships={[rel]}
					connectedObjects={[linked]}
				/>,
			)
			// The current (active) phase is expanded by default, so the row
			// should be visible without clicking anything.
			expect(screen.getByText('Older Insight')).toBeInTheDocument()
		})

		it('renders a missing linked object without throwing (AC-U3 echo)', () => {
			const rel = buildRelationshipResponse({
				id: 'rel-deleted',
				sourceId: 'bet-1',
				targetId: 'obj-gone',
				type: 'breaks_into',
				createdAt: '2026-06-23T10:00:00Z',
			})
			render(
				<ObjectActivity
					workspaceId="ws-1"
					object={bet}
					events={[]}
					relationships={[rel]}
					connectedObjects={[]}
				/>,
			)
			expect(screen.getByText(/unavailable/)).toBeInTheDocument()
		})

		it('buckets a relationship created during an empty non-terminal phase into that phase', async () => {
			const user = userEvent.setup()
			// Object created in 'signal' at T0, then signal→active at T1, then
			// active→done at T2 — the signal phase carries no events of its own.
			// A relationship created at T0.5 falls inside the signal window and
			// must surface there, not in the next phase.
			const betAt = buildObjectResponse({
				id: 'bet-empty-phase',
				type: 'bet',
				status: 'done',
				createdAt: '2026-06-20T00:00:00Z',
			})
			const events = [
				buildEventResponse({
					id: 2,
					action: 'status_changed',
					createdAt: '2026-06-22T00:00:00Z',
					data: { previous: { status: 'active' }, updated: { status: 'done' } },
				}),
				buildEventResponse({
					id: 1,
					action: 'status_changed',
					createdAt: '2026-06-21T00:00:00Z',
					data: { previous: { status: 'signal' }, updated: { status: 'active' } },
				}),
			]
			const linked = buildObjectResponse({ id: 'obj-signal-rel', title: 'Signal-era link' })
			const rel = buildRelationshipResponse({
				id: 'rel-signal',
				sourceId: 'bet-empty-phase',
				targetId: 'obj-signal-rel',
				type: 'informs',
				createdAt: '2026-06-20T12:00:00Z',
			})
			render(
				<ObjectActivity
					workspaceId="ws-1"
					object={betAt}
					events={events}
					relationships={[rel]}
					connectedObjects={[linked]}
				/>,
			)

			// The current (done) phase is expanded by default, so the rel must
			// NOT be visible yet — it belongs to the signal phase, which is
			// collapsed.
			expect(screen.queryByText('Signal-era link')).not.toBeInTheDocument()

			// Expand the signal phase divider — the rel should appear inside.
			const signalTrigger = screen.getByRole('button', { name: /signal/ })
			await user.click(signalTrigger)
			expect(screen.getByText('Signal-era link')).toBeInTheDocument()
		})

		it('shows the Timeline ↔ Table toggle when relationships are present', () => {
			const rel = buildRelationshipResponse({
				id: 'rel-toggle',
				sourceId: 'bet-1',
				targetId: 'obj-link',
				type: 'informs',
				createdAt: '2026-06-23T10:00:00Z',
			})
			render(
				<ObjectActivity
					workspaceId="ws-1"
					object={bet}
					events={[]}
					relationships={[rel]}
					connectedObjects={[]}
				/>,
			)
			expect(screen.getByRole('radio', { name: /timeline/i })).toBeChecked()
			expect(screen.getByRole('radio', { name: /table/i })).not.toBeChecked()
		})
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
