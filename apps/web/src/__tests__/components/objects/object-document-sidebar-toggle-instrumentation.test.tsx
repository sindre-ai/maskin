import { ObjectDocument } from '@/components/objects/object-document'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { buildObjectResponse, buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const trackSidebarToggleMock = vi.fn()

// Stateful mock for the persisted sidebar-collapsed bit. Seeded to `true`
// (collapsed / closed) so every viewport's initial state in these tests is
// deterministically CLOSED — regardless of the breakpoint-default logic in
// `ObjectDocument`. `useUpdateUserDisplaySettings.mutate()` writes to this
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

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: buildWorkspaceWithRole() }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: undefined }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObjectGraph: () => ({ data: undefined }),
	useUpdateObject: () => ({ mutate: vi.fn() }),
	useVerifyObject: () => ({ mutate: vi.fn() }),
	useDeleteObject: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => null,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/activity/object-activity', () => ({
	ObjectActivity: () => null,
}))

vi.mock('@/components/shared/subscribe-toggle', () => ({
	SubscribeToggle: () => null,
}))

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => null,
}))

vi.mock('@/components/objects/linked-objects', () => ({
	LinkedObjects: () => null,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => null,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}))

function setInnerWidth(px: number) {
	Object.defineProperty(window, 'innerWidth', { value: px, configurable: true })
}

beforeEach(() => {
	trackSidebarToggleMock.mockClear()
	setInnerWidth(1280)
	settingsStore.settings = { objectDetailSidebarCollapsed: true }
	settingsStore.subscribers.clear()
})

describe('ObjectDocument sidebar_toggle instrumentation', () => {
	// Ship-metric event for the object-detail-sidebar bet. Every open/close of
	// the right sidebar must fire — the exit gate revokes the feature if this
	// event stays at 0/day for 7 consecutive days.

	it('does not fire on initial mount (default closed state is not a toggle)', () => {
		const object = buildObjectResponse({ id: 'obj-mount' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		expect(trackSidebarToggleMock).not.toHaveBeenCalled()
	})

	it('fires state=open when the PanelRight header button opens the sidebar', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-button' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(trackSidebarToggleMock).toHaveBeenCalledTimes(1)
		expect(trackSidebarToggleMock).toHaveBeenCalledWith({
			state: 'open',
			viewport: 'desktop',
			object_id: 'obj-button',
		})
	})

	it('fires state=closed when the sidebar is dismissed via ESC on the mobile Sheet overlay', async () => {
		// Covers the "any programmatic toggle" leg of the DoD — the mobile
		// Sheet's own `onOpenChange` feeds the same state setter, so ESC /
		// overlay dismissal must emit alongside explicit button/shortcut
		// paths. Runs at mobile since the Sheet branch only renders below
		// 768px; the ≥768 viewports render the sidebar inline, where ESC has
		// nothing to dismiss.
		setInnerWidth(375)
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-close-esc' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'Properties' }))
		trackSidebarToggleMock.mockClear()
		await user.keyboard('{Escape}')

		expect(trackSidebarToggleMock).toHaveBeenCalledWith({
			state: 'closed',
			viewport: 'mobile',
			object_id: 'obj-close-esc',
		})
	})

	it('fires when the ⌘/Ctrl+I shortcut toggles the sidebar', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-shortcut' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await user.keyboard('{Control>}i{/Control}')

		expect(trackSidebarToggleMock).toHaveBeenCalledTimes(1)
		expect(trackSidebarToggleMock).toHaveBeenCalledWith({
			state: 'open',
			viewport: 'desktop',
			object_id: 'obj-shortcut',
		})
	})

	it('reports the tablet viewport for widths in the 768–1023 band', async () => {
		setInnerWidth(900)
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-tablet' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(trackSidebarToggleMock).toHaveBeenCalledWith(
			expect.objectContaining({ viewport: 'tablet' }),
		)
	})

	it('reports the mobile viewport below 768px', async () => {
		setInnerWidth(375)
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-mobile' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(trackSidebarToggleMock).toHaveBeenCalledWith(
			expect.objectContaining({ viewport: 'mobile' }),
		)
	})
})
