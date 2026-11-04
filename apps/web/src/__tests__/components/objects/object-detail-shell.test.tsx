import { ObjectDetailShell } from '@/components/objects/object-detail-shell'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

// The properties drawer's open/closed bit is persisted under the `__chrome__`
// display-settings row, so the toggle only flips once that write lands. A
// stateful store stands in for the round-trip, seeded collapsed.
const settingsStore: {
	settings: { objectDetailSidebarCollapsed: boolean }
	subscribers: Set<() => void>
} = {
	settings: { objectDetailSidebarCollapsed: true },
	subscribers: new Set(),
}
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => {
		const [, force] = React.useReducer((x: number) => x + 1, 0)
		React.useEffect(() => {
			settingsStore.subscribers.add(force)
			return () => {
				settingsStore.subscribers.delete(force)
			}
		}, [])
		return { data: { settings: settingsStore.settings }, isFetched: true }
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

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn(), isPending: false }),
	useUnsubscribe: () => ({ mutate: vi.fn(), isPending: false }),
	useSubscribers: () => ({ data: [] }),
	useMarkRead: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsTouchViewport: () => false,
	useIsDesktopViewport: () => true,
}))

// CommentInput dependencies — stub the API-driven hooks it reaches for.
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Alice', type: 'human' }),
}))

// A post succeeds at once, so the shell's "Comment posted" feedback can be asserted.
vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({
		mutate: (_body: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.(),
		isPending: false,
	}),
}))

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
	toast: Object.assign(toastMock, { error: vi.fn(), success: vi.fn(), message: vi.fn() }),
}))

// Lazily read, like settingsStore, so a test can seed mentionable actors.
const actorsStore: { data: Array<Record<string, unknown>> } = { data: [] }
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: actorsStore.data }),
	useActor: (id: string) => ({ data: actorsStore.data.find((a) => a.id === id) }),
}))

vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => ({ data: undefined }),
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

// The Message composer is the shared Composer behind AgentComposer (own suite); a stub keeps
// this one on the shell's wiring.
vi.mock('@/components/agents/agent-composer', () => ({
	AgentComposer: ({ agent }: { agent: { name: string } }) => (
		<textarea aria-label={`Message ${agent.name}`} placeholder={`Message ${agent.name}…`} />
	),
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

beforeEach(() => {
	settingsStore.settings = { objectDetailSidebarCollapsed: true }
	settingsStore.subscribers.clear()
})

describe('ObjectDetailShell', () => {
	const workspace = {
		settings: {
			statuses: {
				bet: ['proposed', 'active', 'done'],
			},
		},
	}

	it('renders ask banner with the open question when _ask metadata present', () => {
		const object = buildObjectResponse({
			type: 'bet',
			metadata: { _ask: 'Should we ship this?' },
		})
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		expect(screen.getByText(/Open question/)).toBeInTheDocument()
		expect(screen.getByText(/Should we ship this\?/)).toBeInTheDocument()
	})

	it('Answer it opens the Activity tab and moves focus to the answer control', async () => {
		const object = buildObjectResponse({
			type: 'bet',
			metadata: { _ask: 'Should we ship this?' },
		})
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})

		// The composer is pinned under every tab, so it is already there on Overview.
		const answerBox = screen.getByRole('textbox', { name: 'Comment' })
		fireEvent.click(screen.getByRole('button', { name: /answer it/i }))
		await waitFor(() => expect(document.activeElement).toBe(answerBox))
		expect(screen.getByRole('tab', { name: /^Activity/ })).toHaveAttribute('aria-selected', 'true')
	})

	/** Types into the pinned comment box the way a keystroke would, then sends with Enter. */
	function postComment(text: string) {
		const box = screen.getByRole('textbox', { name: 'Comment' })
		box.appendChild(document.createTextNode(text))
		const range = document.createRange()
		range.selectNodeContents(box)
		range.collapse(false)
		document.getSelection()?.removeAllRanges()
		document.getSelection()?.addRange(range)
		fireEvent.input(box)
		fireEvent.keyDown(box, { key: 'Enter' })
	}

	it('offers a way to the timeline after a comment is posted from Overview', () => {
		toastMock.mockClear()
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		postComment('Looks good')

		expect(toastMock).toHaveBeenCalledTimes(1)
		const [message, options] = toastMock.mock.calls[0]
		expect(message).toBe('Comment posted')
		// It does not move the reader on its own ...
		expect(screen.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'true')
		// ... the View action does.
		expect(options.action.label).toBe('View')
		act(() => options.action.onClick())
		expect(screen.getByRole('tab', { name: /^Activity/ })).toHaveAttribute('aria-selected', 'true')
	})

	it('stays quiet when the comment is posted from the Activity tab', () => {
		toastMock.mockClear()
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} tab="activity" />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		postComment('Looks good')
		expect(toastMock).not.toHaveBeenCalled()
	})

	it.each(['overview', 'related', 'activity'] as const)(
		'pins the comment box under the %s tab',
		(tab) => {
			const object = buildObjectResponse({ type: 'bet' })
			render(<ObjectDetailShell object={object} tab={tab} />, {
				wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
			})
			expect(screen.getAllByRole('textbox', { name: 'Comment' })).toHaveLength(1)
		},
	)

	it('omits the ask banner when no _ask metadata', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		expect(screen.queryByText(/Open question/)).not.toBeInTheDocument()
	})

	it('renders comment input at the bottom of the Activity tab', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} tab="activity" />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		// The object page's composer is the single-row bar (mockup 1358–1366).
		expect(screen.getByRole('textbox', { name: 'Comment' })).toBeInTheDocument()
		expect(screen.getByText(/commands, @ mentions/i)).toBeInTheDocument()
	})

	// v16: one column with three tabs; the old Timeline / Related segmented control is gone.
	it('mounts Overview / Related / Activity tabs, Overview first', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		expect(screen.getByRole('tab', { name: /^Overview$/ })).toHaveAttribute('data-state', 'active')
		expect(screen.getByRole('tab', { name: /^Related/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /^Activity/ })).toBeInTheDocument()
		expect(screen.queryByRole('tab', { name: /^Timeline$/ })).toBeNull()
	})

	it('shows no Message switch when the item has no agent to message', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} tab="activity" />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		expect(screen.queryByRole('tab', { name: /^Message/ })).toBeNull()
	})

	it('swaps to the one Message composer when the owner is an agent', () => {
		actorsStore.data = [{ id: 'agent-1', name: 'Bob', type: 'agent', email: null, isSystem: false }]
		const object = buildObjectResponse({ type: 'bet', driver: 'agent-1' })
		render(<ObjectDetailShell object={object} tab="activity" />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		expect(screen.getByRole('textbox', { name: 'Comment' })).toBeInTheDocument()
		const messageTab = screen.getByRole('tab', { name: 'Message Bob' })
		fireEvent.mouseDown(messageTab)
		fireEvent.click(messageTab)
		expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
		expect(screen.getByPlaceholderText('Message Bob…')).toBeInTheDocument()
	})

	it('mounts the properties drawer behind the header toggle', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		const toggle = screen.getByRole('button', { name: 'Properties' })
		expect(toggle).toHaveAttribute('aria-expanded', 'false')
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute('aria-expanded', 'true')
	})

	// D6: the meta row's PAUSED · NO CREDITS chip only shows up when the
	// workspace-scoped `useUsageState()` returns `credits_state === 'empty'`.
	// The default mocks resolve `useBillingUsage` to undefined data, so
	// `useUsageState` never fires — the chip is absent by construction.
	it('omits the PAUSED · NO CREDITS chip by default', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
		})
		expect(screen.queryByText(/NO CREDITS/)).toBeNull()
	})

	it('falls back to Overview when the route owns the tab and ?tab= is missing', () => {
		const itemA = buildObjectResponse({ type: 'bet' })
		const itemB = buildObjectResponse({ type: 'bet' })
		const onTabChange = vi.fn()
		const { rerender } = render(
			<ObjectDetailShell object={itemA} tab="related" onTabChange={onTabChange} />,
			{ wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }) },
		)
		expect(screen.getByRole('tab', { name: /^Related/ })).toHaveAttribute('data-state', 'active')
		// Navigating to another item drops the search param.
		rerender(<ObjectDetailShell object={itemB} onTabChange={onTabChange} />)
		expect(screen.getByRole('tab', { name: /^Overview$/ })).toHaveAttribute('data-state', 'active')
	})
})
