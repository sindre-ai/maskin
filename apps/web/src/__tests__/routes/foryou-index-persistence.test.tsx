import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'

// Routes are tested by extracting the component from the file route and
// rendering it directly, mirroring objects-index-persistence.test.tsx. The
// For You page keeps a local `sort` (session-only, out of scope) but persists
// `mode` through the `__chrome__` display-settings row. These tests guard the
// hydrate (persisted list -> list rows) and write-through (toggle -> upsert
// with foryouViewMode + unrelated settings preserved) directions.
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

// Feed items refilled per test via globalThis so the vi.mock factory reads the
// current state instead of a capture-at-hoist constant.
type FeedState = {
	__foryouItems: UnreadItem[]
}
const feedState = globalThis as unknown as FeedState
feedState.__foryouItems = []

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: () => ({
		data: { items: (globalThis as unknown as FeedState).__foryouItems },
		isLoading: false,
	}),
	useMarkRead: () => ({ mutate: vi.fn() }),
	useMarkUnread: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-bets', () => ({
	useBets: () => ({ data: [], isLoading: false }),
}))

// Track the display-settings read (simulated 404 when null) and every upsert,
// so tests can assert what the route persists and that unrelated settings
// survive the spread.
type SettingsState = {
	__dsPersisted: Record<string, unknown> | null
	__dsUpsertCalls: number
	__dsLastUpsertBody: Record<string, unknown> | null
}
const settingsState = globalThis as unknown as SettingsState
settingsState.__dsPersisted = null
settingsState.__dsUpsertCalls = 0
settingsState.__dsLastUpsertBody = null

vi.mock('@/lib/api', () => {
	class ApiError extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message)
		}
	}
	const state = globalThis as unknown as SettingsState
	return {
		ApiError,
		api: {
			userDisplaySettings: {
				list: async () => ({ items: [] }),
				get: async () => {
					const settings = state.__dsPersisted
					if (settings === null) throw new ApiError(404, 'No display settings for this object type')
					return {
						object_type: '__chrome__',
						name: 'default',
						settings,
						updated_at: '2026-08-11T10:00:00.000Z',
					}
				},
				upsert: async (_wsId: string, _objectType: string, settings: Record<string, unknown>) => {
					state.__dsUpsertCalls++
					state.__dsLastUpsertBody = settings
					// Mirror the server: the row now holds the new blob so a
					// post-invalidate refetch returns the just-written settings.
					state.__dsPersisted = settings
					return {
						object_type: '__chrome__',
						name: 'default',
						settings,
						updated_at: '2026-08-11T10:00:00.000Z',
					}
				},
			},
		},
	}
})

// Heavy/unrelated children are stubbed so the test stays focused on mode
// selection and ordering. The card stub reports which state the feed asked
// for, which is what "cards vs list" means now that both modes render the
// same component.
vi.mock('@/components/foryou/feed-card', () => ({
	FeedCard: ({
		item,
		expanded,
	}: { item: { object?: { title?: string | null } }; expanded: boolean }) => (
		<div data-testid="foryou-feed-card" data-expanded={String(expanded)}>
			{item.object?.title}
		</div>
	),
}))
const pageHeaderProps: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: (props: Record<string, unknown>) => {
		pageHeaderProps.current = props
		return null
	},
}))
vi.mock('@/components/foryou/onboarding-prompt-card', () => ({
	OnboardingPromptCard: () => null,
}))
vi.mock('@/components/foryou/brief-card', () => ({
	BriefCard: () => null,
}))
vi.mock('@/components/foryou/release-card', () => ({
	ReleaseCard: () => null,
}))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

import {
	feedModeToForyouViewMode,
	foryouViewModeToFeedMode,
} from '@/routes/_authed/$workspaceId/index'
import { Route } from '@/routes/_authed/$workspaceId/index'

const RouteOptions = Route as unknown as { component: React.FC }
const ForYouPage = RouteOptions.component

function buildItem(id: string, title: string, type: string): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: id,
		unread_count: 1,
		mentioning_unread_count: 0,
		max_unread_attention: null,
		latest_event_id: 42,
		latest_activity_at: '2026-08-11T10:00:00.000Z',
		object: {
			id,
			workspaceId: 'ws-1',
			type,
			title,
			content: null,
			status: 'active',
			metadata: null,
			driver: null,
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		},
	}
}

function resetState() {
	feedState.__foryouItems = [
		buildItem('thread-1', 'Renewal terms need a read', 'insight'),
		buildItem('thread-2', 'Follow-up from customer call', 'insight'),
	]
	settingsState.__dsPersisted = null
	settingsState.__dsUpsertCalls = 0
	settingsState.__dsLastUpsertBody = null
}

async function flush() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 50))
	})
}

function mount() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	return render(
		<QueryClientProvider client={queryClient}>
			<ForYouPage />
		</QueryClientProvider>,
	)
}

describe('ForYou mode <-> persisted foryouViewMode mapping', () => {
	it('maps missing/card settings to the local "cards" FeedMode', () => {
		expect(foryouViewModeToFeedMode(undefined)).toBe('cards')
		expect(foryouViewModeToFeedMode('card')).toBe('cards')
	})

	it('maps persisted list to the local "list" FeedMode', () => {
		expect(foryouViewModeToFeedMode('list')).toBe('list')
	})

	it('writes the local "cards" FeedMode back as "card"', () => {
		expect(feedModeToForyouViewMode('cards')).toBe('card')
	})

	it('writes the local "list" FeedMode back as "list"', () => {
		expect(feedModeToForyouViewMode('list')).toBe('list')
	})
})

describe('ForYou view-mode persistence via __chrome__ display settings', () => {
	beforeEach(resetState)

	// "Cards" expands every card; "List" collapses them to rows. Both modes
	// render the same FeedCard, so the assertion is on its state.
	function cardStates() {
		return screen.getAllByTestId('foryou-feed-card').map((el) => el.getAttribute('data-expanded'))
	}

	async function pickView(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
		await user.click(screen.getByRole('button', { name: /view options/i }))
		await user.click(await screen.findByRole('menuitem', { name: label }))
	}

	it('expands every card when no display-settings row exists yet', async () => {
		mount()
		await flush()
		expect(cardStates()).toEqual(['true', 'true'])
		// No write happens on first paint for a user who never switches.
		expect(settingsState.__dsUpsertCalls).toBe(0)
	})

	it('renders collapsed rows on re-entry when list was persisted', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		mount()
		await flush()
		expect(cardStates()).toEqual(['false', 'false'])
		expect(screen.getByText('Renewal terms need a read')).toBeInTheDocument()
		expect(screen.getByText('Follow-up from customer call')).toBeInTheDocument()
	})

	it('expands every card when the persisted view is card', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'card' }
		mount()
		await flush()
		expect(cardStates()).toEqual(['true', 'true'])
	})

	it('persists foryouViewMode=list when List is selected, preserving unrelated settings', async () => {
		settingsState.__dsPersisted = { objectDetailSidebarCollapsed: true }
		const user = userEvent.setup()
		mount()
		await flush()

		await pickView(user, /^List/)
		await flush()

		expect(settingsState.__dsUpsertCalls).toBe(1)
		expect(settingsState.__dsLastUpsertBody).toEqual({
			objectDetailSidebarCollapsed: true,
			foryouViewMode: 'list',
		})
		expect(cardStates()).toEqual(['false', 'false'])
	})

	it('does not re-upsert when the already-active List row is clicked', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		const user = userEvent.setup()
		mount()
		await flush()

		await pickView(user, /^List/)
		await flush()

		expect(settingsState.__dsUpsertCalls).toBe(0)
	})

	it('persists foryouViewMode=card when Cards is re-selected from list', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		const user = userEvent.setup()
		mount()
		await flush()
		expect(cardStates()).toEqual(['false', 'false'])

		await pickView(user, /^Cards/)
		await flush()

		expect(settingsState.__dsLastUpsertBody).toMatchObject({ foryouViewMode: 'card' })
		expect(cardStates()).toEqual(['true', 'true'])
	})
})

describe('ForYou attention sort', () => {
	beforeEach(() => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		settingsState.__dsUpsertCalls = 0
		settingsState.__dsLastUpsertBody = null
	})

	it('orders cards by max_unread_attention desc, unscored last, by default', async () => {
		feedState.__foryouItems = [
			{
				...buildItem('low', 'Low attention item', 'insight'),
				max_unread_attention: 2,
				latest_activity_at: '2026-08-10T00:00:00.000Z',
			},
			{
				...buildItem('unscored', 'Unscored item', 'insight'),
				max_unread_attention: null,
				latest_activity_at: '2026-08-15T00:00:00.000Z',
			},
			{
				...buildItem('critical', 'Critical attention item', 'insight'),
				max_unread_attention: 5,
				latest_activity_at: '2026-08-01T00:00:00.000Z',
			},
		]

		mount()
		await flush()

		expect(screen.getAllByTestId('foryou-feed-card').map((el) => el.textContent)).toEqual([
			'Critical attention item',
			'Low attention item',
			'Unscored item',
		])
	})
})

describe('ForYou nav identity + sort options', () => {
	beforeEach(resetState)

	it('publishes title/subtitle into the shared nav instead of its own identity node', async () => {
		mount()
		await flush()
		expect(pageHeaderProps.current.title).toBe('For you')
		expect(pageHeaderProps.current.subtitle).toBe('2 unread')
		expect(pageHeaderProps.current.stickyIdentity).toBeUndefined()
	})

	it('reads "All caught up" once nothing is unread', async () => {
		feedState.__foryouItems = []
		mount()
		await flush()
		expect(pageHeaderProps.current.subtitle).toBe('All caught up')
	})

	it('orders cards newest-first when Chronological is picked', async () => {
		feedState.__foryouItems = [
			{
				...buildItem('older', 'Older thread', 'insight'),
				max_unread_attention: 5,
				latest_activity_at: '2026-08-01T00:00:00.000Z',
			},
			{
				...buildItem('newer', 'Newer thread', 'insight'),
				max_unread_attention: 1,
				latest_activity_at: '2026-08-15T00:00:00.000Z',
			},
		]
		const user = userEvent.setup()
		mount()
		await flush()
		// Attention order first: the older, higher-scored thread leads.
		expect(screen.getAllByTestId('foryou-feed-card').map((el) => el.textContent)).toEqual([
			'Older thread',
			'Newer thread',
		])

		await user.click(screen.getByRole('button', { name: /view options/i }))
		await user.click(await screen.findByRole('menuitem', { name: /Chronological/ }))
		await flush()

		expect(screen.getAllByTestId('foryou-feed-card').map((el) => el.textContent)).toEqual([
			'Newer thread',
			'Older thread',
		])
	})
})
