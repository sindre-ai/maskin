import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildObjectResponse, buildWorkspaceWithRole } from '../factories'

// URL is the source of truth for the search view: the input syncs from
// `search.q`, and every filter interaction commits back through navigate().
const searchState = vi.hoisted(() => ({
	current: {
		q: undefined as string | undefined,
		type: undefined as string | undefined,
		status: undefined as string | undefined,
		group: undefined as string | undefined,
	},
}))
const navigateMock = vi.hoisted(() => vi.fn())
const historyBackMock = vi.hoisted(() => vi.fn())
const paletteOpenMock = vi.hoisted(() => vi.fn())
const searchResultsRef = vi.hoisted(() => ({
	current: { data: undefined as unknown, isFetching: false },
}))
const objectsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
// The cross-entity index composes four more list hooks; each test opts into
// the rows it needs by writing into these refs.
const loopsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const actorsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const triggersRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const conversationsRef = vi.hoisted(() => ({ current: { data: undefined as unknown } }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => searchState.current,
		useNavigate: () => navigateMock,
		useRouter: () => ({ history: { back: historyBackMock } }),
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: buildWorkspaceWithRole({
			settings: { statuses: { bet: ['active', 'archived'] } },
		}),
	}),
}))

vi.mock('@/lib/command-palette-context', () => ({
	useCommandPalette: () => ({ open: false, setOpen: paletteOpenMock }),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObjects: () => objectsRef.current,
	useSearchObjects: () => searchResultsRef.current,
}))

vi.mock('@/hooks/use-loops', () => ({ useLoops: () => loopsRef.current }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => actorsRef.current }))
vi.mock('@/hooks/use-triggers', () => ({ useTriggers: () => triggersRef.current }))
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => conversationsRef.current,
}))

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
	trackCommandPaletteOpened: vi.fn(),
	trackSearchResultOpened: vi.fn(),
}))

vi.mock('@/lib/search-recents', () => ({
	getRecentSearches: vi.fn(() => []),
	getRecentObjectIds: vi.fn(() => []),
	pushRecentSearch: vi.fn(),
	pushRecentObject: vi.fn(),
}))

import { trackCommandPaletteOpened, trackSearchResultOpened } from '@/lib/analytics'
import {
	getRecentObjectIds,
	getRecentSearches,
	pushRecentObject,
	pushRecentSearch,
} from '@/lib/search-recents'
import { Route } from '@/routes/_authed/$workspaceId/search'

const RouteOptions = Route as unknown as { component: React.FC }
const SearchView = RouteOptions.component

beforeEach(() => {
	searchState.current = { q: undefined, type: undefined, status: undefined, group: undefined }
	navigateMock.mockClear()
	historyBackMock.mockClear()
	paletteOpenMock.mockClear()
	vi.mocked(trackCommandPaletteOpened).mockClear()
	vi.mocked(trackSearchResultOpened).mockClear()
	vi.mocked(pushRecentObject).mockClear()
	vi.mocked(pushRecentSearch).mockClear()
	searchResultsRef.current = { data: undefined, isFetching: false }
	objectsRef.current = { data: [] }
	loopsRef.current = { data: [] }
	actorsRef.current = { data: [] }
	triggersRef.current = { data: [] }
	conversationsRef.current = { data: undefined }
})

describe('SearchView', () => {
	it('fires command_palette_opened with the search_view surface on mount', () => {
		render(<SearchView />)

		expect(trackCommandPaletteOpened).toHaveBeenCalledWith({ surface: 'search_view' })
	})

	it('shows the RECENT pill row and recent objects when the query is empty', () => {
		vi.mocked(getRecentSearches).mockReturnValue(['docs'])
		const obj = buildObjectResponse({ id: 'obj-1', title: 'Alpha Insight', type: 'insight' })
		vi.mocked(getRecentObjectIds).mockReturnValue(['obj-1'])
		objectsRef.current = { data: [obj] }

		render(<SearchView />)

		expect(screen.getByText('Search the workspace')).toBeInTheDocument()
		expect(screen.getByText('Recent')).toBeInTheDocument()
		expect(screen.getByText('docs')).toBeInTheDocument()
		expect(screen.getByText('Recent objects')).toBeInTheDocument()
		expect(screen.getByText('Alpha Insight')).toBeInTheDocument()
	})

	it('renders search results with the matched term highlighted and the row count', () => {
		searchState.current.q = 'alpha'
		const obj = buildObjectResponse({
			id: 'obj-1',
			title: 'Alpha Insight',
			content: 'the alpha draft',
			type: 'insight',
		})
		searchResultsRef.current = { data: [obj], isFetching: false }

		render(<SearchView />)

		expect(screen.getByRole('button', { name: /Alpha Insight/ })).toBeInTheDocument()
		expect(
			screen.getByText(
				(_, el) =>
					el?.tagName === 'P' &&
					(el.textContent ?? '').replace(/\s+/g, ' ').includes('1 result for'),
			),
		).toBeInTheDocument()
		const mark = document.querySelector('mark')
		expect(mark?.textContent).toBe('Alpha')
	})

	it('gives every row the same trailing kind column, with object status in the title suffix', () => {
		searchState.current.q = 'relay'
		searchResultsRef.current = {
			data: [
				buildObjectResponse({
					id: 'obj-1',
					title: 'Relay Insight',
					type: 'insight',
					status: 'in_progress',
				}),
			],
			isFetching: false,
		}
		actorsRef.current = {
			data: [{ id: 'a-1', type: 'agent', name: 'Relay', description: 'Handles handoffs.' }],
		}

		render(<SearchView />)

		// Mockup 2544: the right edge reads as one uniform kind label across
		// entity types — the object row no longer breaks it with a status pill.
		expect(screen.getByText('INSIGHT')).toBeInTheDocument()
		expect(screen.getByText('AGENT')).toBeInTheDocument()
		const row = screen.getByRole('button', { name: /Relay Insight/ })
		expect(row.textContent).toContain('— In progress')
	})

	it('groups results per entity and heads each group with its own count', () => {
		searchState.current.q = 'relay'
		searchResultsRef.current = {
			data: [buildObjectResponse({ id: 'obj-1', title: 'Relay Insight', type: 'insight' })],
			isFetching: false,
		}
		actorsRef.current = {
			data: [
				{ id: 'a-1', type: 'agent', name: 'Relay', description: 'Handles handoffs.' },
				{ id: 'a-2', type: 'agent', name: 'Relay Two', description: null },
				{ id: 'h-1', type: 'human', name: 'Relay Human', description: null },
			],
		}

		render(<SearchView />)

		// Humans never enter the agents group, so the count is 2, not 3.
		expect(screen.getByText('Agents · 2')).toBeInTheDocument()
		expect(screen.getByText('Objects · 1')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Agents \(2\)$/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^All \(3\)$/ })).toBeInTheDocument()
	})

	it('commits a group chip selection to the URL and hides the object filters', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'relay'
		searchResultsRef.current = { data: [], isFetching: false }
		actorsRef.current = { data: [{ id: 'a-1', type: 'agent', name: 'Relay', description: null }] }

		render(<SearchView />)

		expect(screen.getByRole('button', { name: 'All types' })).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /^Agents \(1\)$/ }))

		await waitFor(() => {
			const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
			expect(lastCall?.[0].search.group).toBe('agents')
		})
	})

	it('hides the type and status chips while a non-object group is pinned', () => {
		searchState.current.q = 'relay'
		searchState.current.group = 'agents'
		searchResultsRef.current = { data: [], isFetching: false }
		actorsRef.current = { data: [{ id: 'a-1', type: 'agent', name: 'Relay', description: null }] }

		render(<SearchView />)

		expect(screen.queryByRole('button', { name: 'All types' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Any status' })).not.toBeInTheDocument()
	})

	it('fires search_result_opened, pushes the recent, and navigates when a result is clicked', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'beta'
		const obj = buildObjectResponse({ id: 'bet-1', title: 'Beta Bet', type: 'bet' })
		searchResultsRef.current = { data: [obj], isFetching: false }

		render(<SearchView />)
		await user.click(screen.getByRole('button', { name: /Beta Bet/ }))

		expect(trackSearchResultOpened).toHaveBeenCalledWith({
			entity_id: 'bet-1',
			entity_type: 'bet',
			surface: 'search_view',
		})
		expect(pushRecentObject).toHaveBeenCalledWith('ws-1', 'bet-1')
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId: 'ws-1', objectId: 'bet-1' },
		})
	})

	it('navigates to a non-object row on its own route', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'sweep'
		searchResultsRef.current = { data: [], isFetching: false }
		triggersRef.current = {
			data: [{ id: 'trg-1', name: 'Daily Sweep', type: 'cron', actionPrompt: 'Sweep the inbox' }],
		}

		render(<SearchView />)
		await user.click(screen.getByRole('button', { name: /Daily Sweep/ }))

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/triggers/$triggerId',
			params: { workspaceId: 'ws-1', triggerId: 'trg-1' },
		})
	})

	it('commits a typed query to the URL after the debounce', async () => {
		const user = userEvent.setup()
		render(<SearchView />)

		await user.type(screen.getByRole('textbox', { name: 'Search' }), 'agents')

		await waitFor(() => {
			const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
			expect(lastCall?.[0].search.q).toBe('agents')
		})
	})

	it('reflects type and status chip selections through the URL', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'alpha'
		searchResultsRef.current = {
			data: [buildObjectResponse({ id: 'obj-1', title: 'Alpha', type: 'insight' })],
			isFetching: false,
		}
		render(<SearchView />)

		await user.click(screen.getByRole('button', { name: 'Insight' }))

		await waitFor(() => {
			const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
			expect(lastCall?.[0].search.type).toBe('insight')
		})

		await user.click(screen.getByRole('button', { name: 'Active' }))

		await waitFor(() => {
			const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
			expect(lastCall?.[0].search.status).toBe('active')
		})
	})

	it('renders the no-results state for a query with an empty result set', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'zzz'
		searchResultsRef.current = { data: [], isFetching: false }

		render(<SearchView />)

		expect(screen.getByText('Nothing matches "zzz"')).toBeInTheDocument()
		expect(screen.getByText(/Search looks across chats, loops, agents/)).toBeInTheDocument()

		// The palette is the offered alternative, and the button is a real
		// always-visible control — not a hover reveal.
		await user.click(screen.getByRole('button', { name: /Open commands/ }))
		expect(paletteOpenMock).toHaveBeenCalledWith(true)
	})

	it('pushes a committed query onto the recents from the URL', () => {
		searchState.current.q = 'nav committed'
		searchResultsRef.current = { data: [], isFetching: false }

		render(<SearchView />)

		expect(pushRecentSearch).toHaveBeenCalledWith('ws-1', 'nav committed')
	})

	it('clears the query with a first Esc and steps back with a second', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'docs'
		searchResultsRef.current = { data: [], isFetching: false }
		render(<SearchView />)

		const input = screen.getByRole('textbox', { name: 'Search' })
		await user.keyboard('{Escape}')
		expect(input).toHaveValue('')

		await user.keyboard('{Escape}')
		expect(historyBackMock).toHaveBeenCalled()
	})

	it('runs a recent search from the empty state', async () => {
		const user = userEvent.setup()
		vi.mocked(getRecentSearches).mockReturnValue(['docs'])

		render(<SearchView />)
		await user.click(screen.getByText('docs'))

		expect(pushRecentSearch).toHaveBeenCalledWith('ws-1', 'docs')
		const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
		expect(lastCall?.[0].search.q).toBe('docs')
	})
})
