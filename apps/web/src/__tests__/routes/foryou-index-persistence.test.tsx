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
}))

vi.mock('@/hooks/use-bets', () => ({
	useBets: () => ({ data: [], isLoading: false }),
}))

vi.mock('@/lib/new-conversation-context', () => ({
	useNewConversationComposer: () => ({ open: false, setOpen: vi.fn() }),
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
// selection; ForYouListRow renders for real so list mode is asserted via
// actual row links.
vi.mock('@/components/foryou/foryou-card-queue', () => ({
	ForYouCardQueue: () => <div data-testid="foryou-card-queue" />,
}))
vi.mock('@/components/foryou/sparse-composer', () => ({
	SparseComposer: () => null,
}))
vi.mock('@/components/foryou/north-star-prompt-card', () => ({
	NorthStarPromptCard: () => null,
}))
vi.mock('@/components/foryou/onboarding-prompt-card', () => ({
	OnboardingPromptCard: () => null,
}))
vi.mock('@/components/foryou/new-conversation-composer', () => ({
	NewConversationComposer: () => null,
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

	it('renders the card queue when no display-settings row exists yet', async () => {
		mount()
		await flush()
		expect(screen.getByTestId('foryou-card-queue')).toBeInTheDocument()
		expect(
			screen.queryByRole('link', { name: 'Renewal terms need a read' }),
		).not.toBeInTheDocument()
		// No write happens on first paint for a user who never switches.
		expect(settingsState.__dsUpsertCalls).toBe(0)
	})

	it('renders list rows on re-entry when list was persisted', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		mount()
		await flush()
		expect(screen.queryByTestId('foryou-card-queue')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Renewal terms need a read' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Follow-up from customer call' })).toBeInTheDocument()
	})

	it('renders the card queue when the persisted view is card', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'card' }
		mount()
		await flush()
		expect(screen.getByTestId('foryou-card-queue')).toBeInTheDocument()
		expect(
			screen.queryByRole('link', { name: 'Renewal terms need a read' }),
		).not.toBeInTheDocument()
	})

	it('persists foryouViewMode=list when the List tab is selected, preserving unrelated settings', async () => {
		settingsState.__dsPersisted = { objectDetailSidebarCollapsed: true }
		const user = userEvent.setup()
		mount()
		await flush()

		await user.click(screen.getByRole('button', { name: /display options/i }))
		await user.click(screen.getByRole('tab', { name: /list/i }))
		await flush()

		expect(settingsState.__dsUpsertCalls).toBe(1)
		expect(settingsState.__dsLastUpsertBody).toEqual({
			objectDetailSidebarCollapsed: true,
			foryouViewMode: 'list',
		})
		expect(screen.queryByTestId('foryou-card-queue')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Renewal terms need a read' })).toBeInTheDocument()
	})

	it('does not re-upsert when the already-active List tab is clicked', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		const user = userEvent.setup()
		mount()
		await flush()

		await user.click(screen.getByRole('button', { name: /display options/i }))
		await user.click(screen.getByRole('tab', { name: /list/i }))
		await flush()

		expect(settingsState.__dsUpsertCalls).toBe(0)
	})

	it('persists foryouViewMode=card when Cards is re-selected from list', async () => {
		settingsState.__dsPersisted = { foryouViewMode: 'list' }
		const user = userEvent.setup()
		mount()
		await flush()
		expect(screen.getByRole('link', { name: 'Renewal terms need a read' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /display options/i }))
		await user.click(screen.getByRole('tab', { name: /cards/i }))
		await flush()

		expect(settingsState.__dsLastUpsertBody).toMatchObject({ foryouViewMode: 'card' })
		expect(screen.getByTestId('foryou-card-queue')).toBeInTheDocument()
	})
})
