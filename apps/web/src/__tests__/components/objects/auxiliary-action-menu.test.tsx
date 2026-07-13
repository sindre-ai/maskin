import { AuxiliaryActionMenu } from '@/components/objects/auxiliary-action-menu'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

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
})
