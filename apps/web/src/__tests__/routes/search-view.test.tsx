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
	},
}))
const navigateMock = vi.hoisted(() => vi.fn())
const historyBackMock = vi.hoisted(() => vi.fn())
const searchResultsRef = vi.hoisted(() => ({
	current: { data: undefined as unknown, isFetching: false },
}))
const objectsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))

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

vi.mock('@/hooks/use-objects', () => ({
	useObjects: () => objectsRef.current,
	useSearchObjects: () => searchResultsRef.current,
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
	searchState.current = { q: undefined, type: undefined, status: undefined }
	navigateMock.mockClear()
	historyBackMock.mockClear()
	vi.mocked(trackCommandPaletteOpened).mockClear()
	vi.mocked(trackSearchResultOpened).mockClear()
	vi.mocked(pushRecentObject).mockClear()
	vi.mocked(pushRecentSearch).mockClear()
	searchResultsRef.current = { data: undefined, isFetching: false }
	objectsRef.current = { data: [] }
})

describe('SearchView', () => {
	it('fires command_palette_opened with the search_view surface on mount', () => {
		render(<SearchView />)

		expect(trackCommandPaletteOpened).toHaveBeenCalledWith({ surface: 'search_view' })
	})

	it('shows recent searches and recent objects when the query is empty', () => {
		vi.mocked(getRecentSearches).mockReturnValue(['docs'])
		const obj = buildObjectResponse({ id: 'obj-1', title: 'Alpha Insight', type: 'insight' })
		vi.mocked(getRecentObjectIds).mockReturnValue(['obj-1'])
		objectsRef.current = { data: [obj] }

		render(<SearchView />)

		expect(screen.getByText('Recent searches')).toBeInTheDocument()
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

	it('renders the no-results state for a query with an empty result set', () => {
		searchState.current.q = 'zzz'
		searchResultsRef.current = { data: [], isFetching: false }

		render(<SearchView />)

		expect(screen.getByText('No results for “zzz”')).toBeInTheDocument()
		expect(screen.getByText(/Try a different term/)).toBeInTheDocument()
	})

	it('clears the query with a first Esc and steps back with a second', async () => {
		const user = userEvent.setup()
		searchState.current.q = 'docs'
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
