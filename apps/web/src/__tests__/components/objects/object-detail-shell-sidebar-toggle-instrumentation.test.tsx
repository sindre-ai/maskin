import { ObjectDetailShell } from '@/components/objects/object-detail-shell'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const trackSidebarToggleMock = vi.fn()

// Stateful mock for the persisted sidebar-collapsed bit. Seeded to `true`
// (collapsed / closed) so every viewport's initial state in these tests is
// deterministically CLOSED — regardless of the breakpoint-default logic in
// `ObjectDetailShell`. `useUpdateUserDisplaySettings.mutate()` writes to this
// store and bumps a version, which re-renders the query consumers.
const settingsStore: {
	settings: { objectDetailSidebarCollapsed: boolean }
	subscribers: Set<() => void>
} = {
	settings: { objectDetailSidebarCollapsed: true },
	subscribers: new Set(),
}
function useSettingsStore() {
	const [, force] = React.useReducer((x: number) => x + 1, 0)
	React.useEffect(() => {
		settingsStore.subscribers.add(force)
		return () => {
			settingsStore.subscribers.delete(force)
		}
	}, [])
	return settingsStore.settings
}
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => {
		const settings = useSettingsStore()
		return {
			data: {
				object_type: '__chrome__',
				name: 'default',
				settings,
				updated_at: '2026-01-01T00:00:00Z',
			},
			isFetched: true,
		}
	},
	useUpdateUserDisplaySettings: () => ({
		mutate: ({ settings }: { settings: { objectDetailSidebarCollapsed: boolean } }) => {
			settingsStore.settings = settings
			for (const sub of settingsStore.subscribers) sub()
		},
	}),
}))

// The viewport the component reads is driven from one place so a test can move
// `window.innerWidth` and the breakpoint hooks in lockstep.
const viewport = { width: 1280 }
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => viewport.width < 768,
	useIsTouchViewport: () => viewport.width < 1024,
	useIsDesktopViewport: () => viewport.width >= 1024,
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
	trackSidebarToggle: (...args: unknown[]) => trackSidebarToggleMock(...args),
	deriveSidebarViewport: (width: number) => {
		if (width < 768) return 'mobile'
		if (width < 1024) return 'tablet'
		return 'desktop'
	},
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Alice', type: 'human' }),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-notifications', () => ({
	useNotifications: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-objects', () => ({
	useUpdateObject: () => ({ mutate: vi.fn() }),
	useDeleteObject: () => ({ mutate: vi.fn(), isPending: false }),
	useObject: () => ({ data: undefined, isLoading: false }),
	useObjectGraph: () => ({ data: { events: [], relationships: [], connected_objects: [] } }),
	useObjects: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [] }),
	useUpdateWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
	useWorkspaces: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: () => ({ mutate: vi.fn() }),
	useDeleteRelationship: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn(), isPending: false }),
	useUnsubscribe: () => ({ mutate: vi.fn(), isPending: false }),
	useSubscribers: () => ({ data: [] }),
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

function setViewport(px: number) {
	viewport.width = px
	Object.defineProperty(window, 'innerWidth', { value: px, configurable: true })
}

function renderShell(id: string) {
	return render(<ObjectDetailShell object={buildObjectResponse({ id, type: 'bet' })} />, {
		wrapper: createWorkspaceWrapper(
			{ settings: { statuses: { bet: ['active'] } } },
			{ renderPageHeader: true },
		),
	})
}

beforeEach(() => {
	trackSidebarToggleMock.mockClear()
	setViewport(1280)
	settingsStore.settings = { objectDetailSidebarCollapsed: true }
	settingsStore.subscribers.clear()
})

describe('ObjectDetailShell sidebar_toggle instrumentation', () => {
	// Ship-metric event for the object-detail-sidebar bet, ported from the
	// retired ObjectDocument surface along with the ⌘/Ctrl+⇧+\ chord and the
	// persisted `objectDetailSidebarCollapsed` bit. Every open/close of the
	// right sidebar must fire — the exit gate revokes the feature if this
	// event stays at 0/day for 7 consecutive days.

	it('does not fire on initial mount (default closed state is not a toggle)', () => {
		renderShell('obj-mount')

		expect(trackSidebarToggleMock).not.toHaveBeenCalled()
	})

	it('fires state=open when the PanelRight header button opens the sidebar', async () => {
		const user = userEvent.setup()
		renderShell('obj-button')

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(trackSidebarToggleMock).toHaveBeenCalledTimes(1)
		expect(trackSidebarToggleMock).toHaveBeenCalledWith({
			state: 'open',
			viewport: 'desktop',
			object_id: 'obj-button',
		})
	})

	it('fires when the ⌘/Ctrl+⇧+\\ shortcut toggles the sidebar', async () => {
		const user = userEvent.setup()
		renderShell('obj-shortcut')

		await user.keyboard('{Control>}{Shift>}\\{/Shift}{/Control}')

		expect(trackSidebarToggleMock).toHaveBeenCalledTimes(1)
		expect(trackSidebarToggleMock).toHaveBeenCalledWith({
			state: 'open',
			viewport: 'desktop',
			object_id: 'obj-shortcut',
		})
	})

	it('persists the collapsed bit so the toggle survives a remount', async () => {
		const user = userEvent.setup()
		const { unmount } = renderShell('obj-persist')

		await user.click(screen.getByRole('button', { name: 'Properties' }))
		expect(settingsStore.settings.objectDetailSidebarCollapsed).toBe(false)

		unmount()
		renderShell('obj-persist')
		expect(screen.getByRole('button', { name: 'Properties' })).toHaveAttribute(
			'aria-expanded',
			'true',
		)
	})

	it('reports the tablet viewport for widths in the 768–1023 band', async () => {
		setViewport(900)
		const user = userEvent.setup()
		renderShell('obj-tablet')

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(trackSidebarToggleMock).toHaveBeenCalledWith(
			expect.objectContaining({ viewport: 'tablet' }),
		)
	})

	it('reports the mobile viewport below 768px', async () => {
		setViewport(375)
		const user = userEvent.setup()
		renderShell('obj-mobile')

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(trackSidebarToggleMock).toHaveBeenCalledWith(
			expect.objectContaining({ viewport: 'mobile' }),
		)
	})
})
