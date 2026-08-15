import { AuxiliaryActionMenu } from '@/components/objects/auxiliary-action-menu'
import type { MemberResponse } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

// Mutable so individual tests can flip the viewport class.
const viewport = { isMobile: false, isTouch: false }
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => viewport.isMobile,
	useIsTouchViewport: () => viewport.isTouch,
}))

beforeEach(() => {
	viewport.isMobile = false
	viewport.isTouch = false
})

const members: MemberResponse[] = [
	{ actorId: 'a-1', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
	{ actorId: 'a-2', role: 'member', joinedAt: null, name: 'Bob', type: 'agent' },
]

function makeWrapper() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
}

describe('AuxiliaryActionMenu', () => {
	// One handler, two entry points: the Archive menu item is only useful for
	// bets — the workspace bet enum is the sole default carrier of `archived`,
	// and applying archive to non-bet types is out of scope for this ship.
	it('renders Archive above Delete for bets', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))

		const archive = await screen.findByRole('menuitem', { name: /archive/i })
		const del = screen.getByRole('menuitem', { name: /delete/i })
		expect(archive).toBeInTheDocument()
		expect(del).toBeInTheDocument()
		// DOM order: Archive precedes Delete.
		expect(archive.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('hides Archive for non-bet objects', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'task', status: 'todo' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))

		expect(screen.queryByRole('menuitem', { name: /archive/i })).not.toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument()
	})

	it('hides Archive when the bet is already archived', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet', status: 'archived' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))
		expect(screen.queryByRole('menuitem', { name: /archive/i })).not.toBeInTheDocument()
	})

	it('fires onArchiveRequest when the Archive item is clicked', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onArchive = vi.fn()
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={onArchive}
				workspaceId="ws-1"
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))
		await user.click(screen.getByRole('menuitem', { name: /archive/i }))
		expect(onArchive).toHaveBeenCalledTimes(1)
	})

	// Keyboard shortcut `A` fires the archive action while the menu is open —
	// mirrors the shortcuts published in the menu (E, ⇧T, ⇧C, S, ⌘⌫). The
	// listener is gated on the controlled `open` prop, so the test asserts the
	// controlled path the parent (object-document) actually wires up.
	it('fires onArchiveRequest when the A shortcut is pressed while the menu is open', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onArchive = vi.fn()
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={onArchive}
				workspaceId="ws-1"
				open
				onOpenChange={vi.fn()}
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.keyboard('a')
		expect(onArchive).toHaveBeenCalledTimes(1)
	})

	// The A shortcut is a no-op when there is no Archive item to fire (non-bet
	// menu). Otherwise the shortcut could pretend to work on tasks/insights
	// where archive isn't yet a supported route.
	it('does not fire archive on `A` when Archive is not in the menu', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onArchive = vi.fn()
		const object = buildObjectResponse({ type: 'task', status: 'todo' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={onArchive}
				workspaceId="ws-1"
				open
				onOpenChange={vi.fn()}
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.keyboard('a')
		expect(onArchive).not.toHaveBeenCalled()
	})

	// Properties group — narrow desktop popover (touch viewport ≤1024). The
	// Status + Driver rows lead the menu so users can edit those fields when
	// the sticky nav shows only the read-only chip.
	it('renders Properties group on narrow desktop popover when props are provided', async () => {
		viewport.isTouch = true
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
				statuses={['active', 'archived']}
				members={members}
				currentDriverId={null}
				onStatusChange={vi.fn()}
				onDriverChange={vi.fn()}
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))

		expect(screen.getByText(/properties/i)).toBeInTheDocument()
		expect(screen.getByText(/^status$/i)).toBeInTheDocument()
		expect(screen.getByText(/^driver$/i)).toBeInTheDocument()
	})

	it('omits Properties group on wide desktop even when props are provided', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
				statuses={['active', 'archived']}
				members={members}
				currentDriverId={null}
				onStatusChange={vi.fn()}
				onDriverChange={vi.fn()}
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))

		expect(screen.queryByText(/properties/i)).not.toBeInTheDocument()
	})

	// Mobile Sheet — Properties group leads before the action rows.
	it('renders Properties group at the top of the Sheet on mobile', async () => {
		viewport.isMobile = true
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
				statuses={['active', 'archived']}
				members={members}
				currentDriverId="a-1"
				onStatusChange={vi.fn()}
				onDriverChange={vi.fn()}
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))

		const statusLabel = screen.getByText(/^status$/i)
		const driverLabel = screen.getByText(/^driver$/i)
		const deleteRow = screen.getByRole('button', { name: /delete/i })
		expect(statusLabel).toBeInTheDocument()
		expect(driverLabel).toBeInTheDocument()
		// DOM order: Status leads, then Driver, then the action rows.
		expect(
			statusLabel.compareDocumentPosition(driverLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
		expect(
			driverLabel.compareDocumentPosition(deleteRow) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
	})

	// If the parent doesn't wire the Properties props, the group is silently
	// omitted — matches the "wide desktop untouched" DoD when callers haven't
	// opted in.
	it('omits Properties group when the callbacks are not provided', async () => {
		viewport.isTouch = true
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet', status: 'active' })

		render(
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))
		expect(screen.queryByText(/properties/i)).not.toBeInTheDocument()
	})
})
