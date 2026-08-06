import { ObjectActivity } from '@/components/activity/object-activity'
import type { DisplaySettingsBody, UserDisplaySettingsResponse } from '@/lib/api'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSyncExternalStore } from 'react'
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

// Stateful mock so a mutate() call actually re-renders the consumers with the
// new settings — mirrors what the real TanStack Query cache does after
// onMutate. Without this, tests can never observe the post-toggle view.
let mockSettings: UserDisplaySettingsResponse | null = null
// getSnapshot must be referentially stable across renders when the underlying
// value hasn't changed, otherwise useSyncExternalStore loops. Return the same
// wrapper object per settings identity.
let mockSnapshot: { data: UserDisplaySettingsResponse | null } = { data: null }
const listeners = new Set<() => void>()
const setMockSettings = (next: UserDisplaySettingsResponse | null) => {
	mockSettings = next
	mockSnapshot = { data: next }
	for (const l of listeners) l()
}

vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () =>
		useSyncExternalStore(
			(cb) => {
				listeners.add(cb)
				return () => listeners.delete(cb)
			},
			() => mockSnapshot,
			() => mockSnapshot,
		),
	useUpdateUserDisplaySettings: () => ({
		mutate: ({
			objectType,
			settings,
		}: {
			objectType: string
			settings: DisplaySettingsBody
		}) => {
			setMockSettings({
				object_type: objectType,
				name: 'default',
				settings,
				updated_at: new Date().toISOString(),
			})
		},
		isPending: false,
	}),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Me', type: 'human' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const bet = buildObjectResponse({ id: 'bet-1', status: 'active', type: 'bet' })

describe('ObjectActivity — Timeline ↔ Table format switch', () => {
	beforeEach(() => {
		setMockSettings(null)
	})

	it('renders activity content in both directions when toggling views without needing a refresh', async () => {
		const user = userEvent.setup()

		// Realistic mix: one status change event, one relationship. In Timeline
		// view the relationship gets projected inline; in Table view it moves
		// to the RelationshipsTable above the timeline. Either way, the
		// per-phase content must stay visible.
		const events = [
			buildEventResponse({
				id: 1,
				action: 'status_changed',
				createdAt: '2026-06-22T00:00:00Z',
				data: { previous: { status: 'signal' }, updated: { status: 'active' } },
			}),
		]
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
				events={events}
				relationships={[rel]}
				connectedObjects={[linked]}
			/>,
		)

		// Timeline default: the linked insight surfaces inside the phase.
		expect(screen.getByText('Linked Insight')).toBeInTheDocument()
		expect(screen.getByText('set the status to Active')).toBeInTheDocument()

		// Flip to Table format.
		const tableRadio = screen.getByRole('radio', { name: /table/i })
		await user.click(tableRadio)

		// After the toggle the status-change row must remain visible (it's an
		// event, not a relationship) and the linked object must still surface —
		// now inside the RelationshipsTable rather than the phase.
		await waitFor(() => {
			expect(tableRadio).toBeChecked()
		})
		expect(screen.getByText('set the status to Active')).toBeInTheDocument()
		expect(screen.getByText('Linked Insight')).toBeInTheDocument()

		// Flip back to Timeline — must still render, no blank state.
		const timelineRadio = screen.getByRole('radio', { name: /timeline/i })
		await user.click(timelineRadio)
		await waitFor(() => {
			expect(timelineRadio).toBeChecked()
		})
		expect(screen.getByText('set the status to Active')).toBeInTheDocument()
		expect(screen.getByText('Linked Insight')).toBeInTheDocument()
	})

	it('preserves per-phase collapsed state across format toggles (phase state must not slide onto neighbouring phases)', async () => {
		const user = userEvent.setup()

		// Build a bet with three status phases so we have room for a phase to
		// drop out on the Table view without emptying the timeline. The
		// leading "signal" phase carries only a relationship (its edge was
		// created before any status change), so it disappears when
		// relationships stop being projected into the timeline (Table view).
		// The remaining two phases (active, done) carry events and stay in
		// both views.
		const events = [
			buildEventResponse({
				id: 3,
				action: 'commented',
				createdAt: '2026-06-25T10:00:00Z',
				data: { content: 'done phase comment' },
			}),
			buildEventResponse({
				id: 2,
				action: 'status_changed',
				createdAt: '2026-06-24T00:00:00Z',
				data: { previous: { status: 'active' }, updated: { status: 'done' } },
			}),
			buildEventResponse({
				id: 1,
				action: 'status_changed',
				createdAt: '2026-06-22T00:00:00Z',
				data: { previous: { status: 'signal' }, updated: { status: 'active' } },
			}),
		]
		const doneBet = buildObjectResponse({
			id: 'bet-done',
			type: 'bet',
			status: 'done',
			createdAt: '2026-06-20T00:00:00Z',
		})
		const linked = buildObjectResponse({ id: 'obj-link', title: 'Signal-era link' })
		// Rel is timestamped INSIDE the initial signal phase (before
		// 2026-06-22), so it buckets into that phase in Timeline view. That
		// makes signal a relationship-only phase that gets filtered out in
		// Table view — the exact phase-count-changes-on-toggle case that used
		// to slide index-based state onto the wrong surviving phase.
		const rel = buildRelationshipResponse({
			id: 'rel-signal',
			sourceId: 'bet-done',
			targetId: 'obj-link',
			type: 'informs',
			createdAt: '2026-06-21T10:00:00Z',
		})

		render(
			<ObjectActivity
				workspaceId="ws-1"
				object={doneBet}
				events={events}
				relationships={[rel]}
				connectedObjects={[linked]}
			/>,
		)

		// Timeline: signal (relationship only), active (status1 event), done
		// (status2 + comment). All expanded by default.
		expect(screen.getByText('done phase comment')).toBeInTheDocument()
		expect(screen.getByText('Signal-era link')).toBeInTheDocument()

		// Close the active phase (middle one) — the exact phase whose index
		// used to shift when relationships stopped being projected.
		const activeTrigger = screen.getByRole('button', { name: /active/i })
		await user.click(activeTrigger)
		// The active phase's only visible content is its status-change row;
		// with the phase closed, that row goes away.
		expect(screen.queryByText('set the status to Active')).not.toBeInTheDocument()
		// Signal + done stay open.
		expect(screen.getByText('done phase comment')).toBeInTheDocument()
		expect(screen.getByText('Signal-era link')).toBeInTheDocument()

		// Flip to Table. Signal (relationship-only) drops out of the phases
		// array; active + done remain. The user only ever closed the ACTIVE
		// phase — done must NOT silently inherit that closed state.
		await act(async () => {
			await user.click(screen.getByRole('radio', { name: /table/i }))
		})
		// Done phase content must remain visible in Table view.
		expect(screen.getByText('done phase comment')).toBeInTheDocument()
		// Active is still the phase the user closed — its status-change row
		// stays hidden.
		expect(screen.queryByText('set the status to Active')).not.toBeInTheDocument()
		// Signal-era relationship now lives in the RelationshipsTable above
		// the timeline; it must still be reachable.
		expect(screen.getByText('Signal-era link')).toBeInTheDocument()

		// Flip back to Timeline — the signal phase reappears with its rel
		// projection; done stays open; active stays closed.
		await act(async () => {
			await user.click(screen.getByRole('radio', { name: /timeline/i }))
		})
		expect(screen.getByText('Signal-era link')).toBeInTheDocument()
		expect(screen.getByText('done phase comment')).toBeInTheDocument()
		expect(screen.queryByText('set the status to Active')).not.toBeInTheDocument()
	})

	it('keeps activity visible when switching views on a bet with only relationships (no events)', async () => {
		const user = userEvent.setup()
		const linked = buildObjectResponse({ id: 'obj-link', title: 'Only Link' })
		const rel = buildRelationshipResponse({
			id: 'rel-only',
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

		// Timeline view — projected inline.
		expect(screen.getByText('Only Link')).toBeInTheDocument()

		await user.click(screen.getByRole('radio', { name: /table/i }))
		// Table view — relationship should show in the RelationshipsTable.
		expect(screen.getByText('Only Link')).toBeInTheDocument()

		await user.click(screen.getByRole('radio', { name: /timeline/i }))
		// Back to timeline — must render again without a refresh.
		expect(screen.getByText('Only Link')).toBeInTheDocument()
	})
})
