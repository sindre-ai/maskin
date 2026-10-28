import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const searchState = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }))
const navigateMock = vi.hoisted(() => vi.fn())
const historyBackMock = vi.hoisted(() => vi.fn())
const onlineRef = vi.hoisted(() => ({ current: true }))
const canGoBackRef = vi.hoisted(() => ({ current: true }))

vi.mock('@tanstack/react-router', () => ({
	useSearch: () => searchState.current,
	useNavigate: () => navigateMock,
	useRouter: () => ({
		history: { back: historyBackMock, canGoBack: () => canGoBackRef.current },
	}),
}))

vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }))

vi.mock('@/lib/api', () => ({
	api: { search: { query: vi.fn() } },
}))

vi.mock('@/hooks/use-objects', () => ({ useObjects: () => ({ data: [] }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => onlineRef.current }))
vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [
		{ value: 'bet', label: 'Bets' },
		{ value: 'company', label: 'Companies' },
		{ value: 'loop', label: 'Loops' },
	],
}))

vi.mock('@/lib/analytics', () => ({
	trackCommandPaletteOpened: vi.fn(),
	trackSearchFilterChanged: vi.fn(),
	trackSearchPerformed: vi.fn(),
	trackSearchResultOpened: vi.fn(),
}))

import { SearchPageV2 } from '@/components/search/search-page'
import {
	trackSearchFilterChanged,
	trackSearchPerformed,
	trackSearchResultOpened,
} from '@/lib/analytics'
import { api } from '@/lib/api'
import type { SearchResponse } from '@maskin/shared'

const ROW_IDS = {
	chat: '00000000-0000-4000-8000-000000000001',
	loop: '00000000-0000-4000-8000-000000000002',
	company: '00000000-0000-4000-8000-000000000003',
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
	return {
		results: [
			{
				id: ROW_IDS.chat,
				group: 'chats',
				type: 'chat',
				title: 'Hans on pricing',
				sub: null,
				snippet: 'we talked about hans and pricing',
				status: 'unread',
				statusGroup: 'new',
				updatedAt: null,
			},
			{
				id: ROW_IDS.loop,
				group: 'loops',
				type: 'loop',
				title: 'Hans follow-up loop',
				sub: null,
				snippet: null,
				status: 'live',
				statusGroup: 'in_progress',
				updatedAt: null,
			},
		],
		total: 2,
		capped: false,
		facets: {
			types: { chat: 1, loop: 1, agent: 0, automation: 0, bet: 0, company: 0 },
			statuses: { needs_you: 0, in_progress: 1, new: 1, done: 0, archived: 0 },
		},
		relaxed: { withoutFilters: 2, withoutStatuses: 2 },
		partial: [],
		...overrides,
	}
}

const empty = (overrides: Partial<SearchResponse> = {}) =>
	response({ results: [], total: 0, ...overrides })

function renderPage() {
	const Wrapper = createWorkspaceWrapper({ id: 'ws-1' })
	return render(<SearchPageV2 />, { wrapper: Wrapper })
}

const field = () => screen.getByRole('combobox', { name: 'Search' })

beforeEach(() => {
	searchState.current = {}
	onlineRef.current = true
	canGoBackRef.current = true
	navigateMock.mockClear()
	historyBackMock.mockClear()
	vi.mocked(trackSearchFilterChanged).mockClear()
	vi.mocked(trackSearchPerformed).mockClear()
	vi.mocked(trackSearchResultOpened).mockClear()
	vi.mocked(api.search.query).mockReset()
	vi.mocked(api.search.query).mockResolvedValue(response())
	localStorage.clear()
})

describe('SearchPageV2 results', () => {
	it('shows the field, chips with the endpoint counts, one result count and grouped rows', async () => {
		searchState.current = { q: 'hans' }
		renderPage()

		await screen.findByRole('option', { name: /Hans on pricing/ })
		// One count only, taken from the endpoint total.
		expect(screen.getByText(/2 results/, { selector: 'p' })).toBeInTheDocument()
		expect(screen.queryByText(/matches/)).not.toBeInTheDocument()

		const types = screen.getByRole('group', { name: 'Filter by type' })
		expect(within(types).getByRole('button', { name: 'Chats (1)' })).toBeInTheDocument()
		expect(within(types).getByRole('button', { name: 'Loops (1)' })).toBeInTheDocument()
		// Zero-count chips are hidden unless selected.
		expect(within(types).queryByRole('button', { name: /Agents/ })).not.toBeInTheDocument()

		const statuses = screen.getByRole('group', { name: 'Filter by status' })
		expect(within(statuses).getByRole('button', { name: 'In progress (1)' })).toBeInTheDocument()
		expect(within(statuses).queryByRole('button', { name: /Needs you/ })).not.toBeInTheDocument()

		expect(screen.getByRole('group', { name: 'Chats' })).toBeInTheDocument()
		expect(screen.getByRole('group', { name: 'Loops' })).toBeInTheDocument()
	})

	it('shows the chat snippet but no snippet on other rows', async () => {
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query).mockResolvedValue(
			response({
				results: [
					{
						id: ROW_IDS.loop,
						group: 'loops',
						type: 'loop',
						title: 'Hans follow-up loop',
						sub: null,
						snippet: 'a loop body that must not show',
						status: 'live',
						statusGroup: 'in_progress',
						updatedAt: null,
					},
				],
				total: 1,
			}),
		)
		renderPage()
		await screen.findByRole('option', { name: /Hans follow-up loop/ })
		expect(screen.queryByText(/a loop body that must not show/)).not.toBeInTheDocument()
	})

	it('shows skeletons while the first answer is on its way', async () => {
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query).mockReturnValue(new Promise(() => {}))
		renderPage()

		await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument())
		expect(screen.getAllByText('Searching…').length).toBeGreaterThan(0)
		// The field and chips are usable while it loads, chip counts are dashes.
		expect(field()).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Chats' })).toBeInTheDocument()
	})

	it('shows the cap line when the endpoint says the list is cut', async () => {
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query).mockResolvedValue(response({ total: 412, capped: true }))
		renderPage()
		expect(
			await screen.findByText('Showing 2 of 412. Add a filter to narrow the list.'),
		).toBeInTheDocument()
		expect(screen.getByText(/412 results/, { selector: 'p' })).toBeInTheDocument()
	})

	it('says when some sources could not be loaded', async () => {
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query).mockResolvedValue(response({ partial: ['agents'] }))
		renderPage()
		expect(
			await screen.findByText(/Some results couldn't be loaded, so these counts may be incomplete/),
		).toBeInTheDocument()
	})
})

describe('SearchPageV2 chips under a failed source', () => {
	it('keeps the failed group chip with a dash so it does not read as no matches', async () => {
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query).mockResolvedValue(response({ partial: ['loops'] }))
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })

		const types = screen.getByRole('group', { name: 'Filter by type' })
		const loops = within(types).getByRole('button', { name: 'Loops' })
		expect(loops).toHaveTextContent('–')
		// A source that answered with zero is still hidden.
		expect(within(types).queryByRole('button', { name: /Agents/ })).not.toBeInTheDocument()
	})
})

describe('SearchPageV2 idle', () => {
	it('shows the type chips without a count or a dash when nothing has been asked', () => {
		renderPage()
		const types = screen.getByRole('group', { name: 'Filter by type' })
		expect(within(types).getByRole('button', { name: 'Chats' })).toBeInTheDocument()
		expect(within(types).queryByText('–')).not.toBeInTheDocument()
		const statuses = screen.getByRole('group', { name: 'Filter by status' })
		expect(within(statuses).queryByText('–')).not.toBeInTheDocument()
		expect(api.search.query).not.toHaveBeenCalled()
	})
})

describe('SearchPageV2 while the answer is for earlier words', () => {
	const typeMore = async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query)
			.mockResolvedValueOnce(response())
			.mockReturnValue(new Promise(() => {}))
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })
		return user
	}

	it('keeps the old count line with the old words while the new answer is slow', async () => {
		const user = await typeMore()
		await user.type(field(), ' pricing')
		await waitFor(() => expect(api.search.query).toHaveBeenCalledTimes(2))

		const count = screen.getByText(/2 results/, { selector: 'p' })
		expect(count).toHaveTextContent('2 results for “hans”')
		expect(count).not.toHaveTextContent('pricing')
		// The old rows stay on screen, dimmed, until the new answer settles.
		expect(screen.getByRole('option', { name: /Hans on pricing/ })).toBeInTheDocument()
	})

	it('shows the offline block, with the old count line, when offline with a new query', async () => {
		const user = await typeMore()
		onlineRef.current = false
		await user.type(field(), ' pricing')

		const alert = await screen.findByRole('alert')
		expect(within(alert).getByText("You're offline")).toBeInTheDocument()
		expect(screen.getByText(/2 results/, { selector: 'p' })).toHaveTextContent(
			'2 results for “hans”',
		)
	})
})

describe('SearchPageV2 pills', () => {
	it('turns a typed type word into a pill on Tab, writes it to the URL, and Backspace restores the word', async () => {
		const user = userEvent.setup()
		renderPage()

		await user.type(field(), 'hans loop')
		expect(screen.getByRole('button', { name: /Filter by Loops/ })).toBeInTheDocument()

		await user.keyboard('{Tab}')
		expect(
			screen.getByRole('button', { name: 'Remove filter: Loops, typed as loop' }),
		).toBeInTheDocument()
		expect(field()).toHaveValue('hans ')
		expect(trackSearchFilterChanged).toHaveBeenCalledWith({
			surface: 'search_view',
			dimension: 'type',
			action: 'add',
			value: 'loop',
			kind: 'pill',
			via: 'tab',
		})

		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith(
				expect.objectContaining({ search: { q: 'hans', types: 'loop' }, replace: true }),
			),
		)
		await waitFor(() =>
			expect(api.search.query).toHaveBeenLastCalledWith(
				'ws-1',
				expect.objectContaining({ q: 'hans', types: 'loop' }),
				expect.anything(),
			),
		)

		// Backspace at the start of the input gives the word back.
		;(field() as HTMLInputElement).setSelectionRange(0, 0)
		await user.keyboard('{Backspace}')
		expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument()
		expect(field()).toHaveValue('hans loop')
		expect(trackSearchFilterChanged).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: 'remove', kind: 'pill', via: 'backspace' }),
		)
	})

	it('does not turn the word into a pill on Enter, and Tab only accepts a showing suggestion', async () => {
		const user = userEvent.setup()
		renderPage()
		await user.type(field(), 'hans')
		await user.keyboard('{Enter}')
		expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument()
		expect(trackSearchFilterChanged).not.toHaveBeenCalled()
	})

	it('restores the pills from the URL on load without counting a filter change', async () => {
		searchState.current = { q: 'hans', types: 'loop', statuses: 'done' }
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })
		expect(screen.getByRole('button', { name: 'Remove filter: Loops' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Remove filter: Done' })).toBeInTheDocument()
		expect(field()).toHaveValue('hans')
		expect(trackSearchFilterChanged).not.toHaveBeenCalled()
		expect(api.search.query).toHaveBeenCalledWith(
			'ws-1',
			expect.objectContaining({ q: 'hans', types: 'loop', statuses: 'done' }),
			expect.anything(),
		)
		// A plain restore does not rewrite the URL it came from.
		expect(navigateMock).not.toHaveBeenCalled()
	})

	it('Esc dismisses a showing suggestion before it clears the words', async () => {
		const user = userEvent.setup()
		renderPage()
		await user.type(field(), 'hans loop')
		await user.keyboard('{Escape}')
		expect(screen.queryByRole('button', { name: /Filter by Loops/ })).not.toBeInTheDocument()
		expect(field()).toHaveValue('hans loop')

		await user.keyboard('{Escape}')
		expect(field()).toHaveValue('')
		await user.keyboard('{Escape}')
		expect(historyBackMock).toHaveBeenCalledTimes(1)
	})
})

describe('SearchPageV2 leaving the page', () => {
	it('goes to For you on Esc and on Back when the page was opened from a link', async () => {
		const user = userEvent.setup()
		canGoBackRef.current = false
		renderPage()

		await user.click(field())
		await user.keyboard('{Escape}')
		expect(navigateMock).toHaveBeenLastCalledWith({
			to: '/$workspaceId',
			params: { workspaceId: 'ws-1' },
		})

		navigateMock.mockClear()
		await user.click(screen.getByRole('button', { name: 'Back' }))
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId',
			params: { workspaceId: 'ws-1' },
		})
		expect(historyBackMock).not.toHaveBeenCalled()
	})

	it('steps back in the app when there is history to step back into', async () => {
		const user = userEvent.setup()
		renderPage()
		await user.click(screen.getByRole('button', { name: 'Back' }))
		expect(historyBackMock).toHaveBeenCalledTimes(1)
		expect(navigateMock).not.toHaveBeenCalled()
	})
})

describe('SearchPageV2 chips', () => {
	it('toggles a chip into a pill, reports a user change, and Clear filters removes it', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans' }
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })

		await user.click(screen.getByRole('button', { name: 'Loops (1)' }))
		expect(screen.getByRole('button', { name: 'Remove filter: Loops' })).toBeInTheDocument()
		expect(trackSearchFilterChanged).toHaveBeenCalledWith({
			surface: 'search_view',
			dimension: 'type',
			action: 'add',
			value: 'loop',
			kind: 'chip',
			via: 'click',
		})

		await user.click(await screen.findByRole('button', { name: 'Clear filters' }))
		expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument()
		expect(trackSearchFilterChanged).toHaveBeenLastCalledWith({
			surface: 'search_view',
			dimension: 'clear',
			action: 'reset',
			value: '',
			kind: 'clear_button',
			via: 'click',
		})
		// The words stay.
		expect(field()).toHaveValue('hans')
	})
})

describe('SearchPageV2 Display', () => {
	it('sets the sort from the menu and shows how many Display settings changed', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans' }
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })

		await user.click(screen.getByRole('button', { name: 'Display' }))
		await user.click(await screen.findByRole('radio', { name: 'A to Z' }))

		expect(trackSearchFilterChanged).toHaveBeenCalledWith({
			surface: 'search_view',
			dimension: 'sort',
			action: 'set',
			value: 'az',
			kind: 'display_menu',
			via: 'click',
		})
		await waitFor(() =>
			expect(api.search.query).toHaveBeenLastCalledWith(
				'ws-1',
				expect.objectContaining({ sort: 'az' }),
				expect.anything(),
			),
		)
		expect(screen.getByRole('button', { name: 'Display (1 changed)' })).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans' }
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })
		await user.click(screen.getByRole('button', { name: 'Display' }))
		expect(await screen.findByRole('radio', { name: 'Relevance' })).toBeInTheDocument()
		await user.keyboard('{Escape}')
		await waitFor(() =>
			expect(screen.queryByRole('radio', { name: 'Relevance' })).not.toBeInTheDocument(),
		)
	})
})

describe('SearchPageV2 zero results', () => {
	it('names a status word, offers its chip, and turns it into a pill', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans active' }
		vi.mocked(api.search.query).mockResolvedValueOnce(empty())
		renderPage()

		expect(await screen.findByText('Nothing matches “hans active”')).toBeInTheDocument()
		expect(
			screen.getByText('“active” is a status. Choose it below to filter by status.'),
		).toBeInTheDocument()

		// The field offers the same suggestion; the empty state's chip comes later in the page.
		const chips = screen.getAllByRole('button', { name: 'Filter by In progress' })
		await user.click(chips[chips.length - 1])
		expect(
			screen.getByRole('button', { name: 'Remove filter: In progress, typed as active' }),
		).toBeInTheDocument()
		expect(field()).toHaveValue('hans ')
	})

	it('offers Clear filters and a wider search when a filter emptied the list', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans', statuses: 'archived' }
		vi.mocked(api.search.query).mockResolvedValueOnce(
			empty({ relaxed: { withoutFilters: 9, withoutStatuses: 9 } }),
		)
		renderPage()

		expect(await screen.findByText('No results with these filters')).toBeInTheDocument()
		const wider = screen.getByRole('button', { name: /Search “hans” in everything · 9 results/ })
		await user.click(wider)
		expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument()
		expect(field()).toHaveValue('hans')
	})
})

describe('SearchPageV2 failure', () => {
	it('shows an error row with Retry, keeps the filters, and recovers', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans', types: 'loop' }
		vi.mocked(api.search.query).mockRejectedValueOnce(new Error('boom'))
		renderPage()

		const alert = await screen.findByRole('alert')
		expect(within(alert).getByText("Couldn't run that search")).toBeInTheDocument()
		// A failed search never clears the filters.
		expect(screen.getByRole('button', { name: 'Remove filter: Loops' })).toBeInTheDocument()
		expect(field()).toHaveValue('hans')

		await user.click(within(alert).getByRole('button', { name: 'Retry' }))
		expect(await screen.findByRole('option', { name: /Hans on pricing/ })).toBeInTheDocument()
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})

	it('says it is offline, with Retry disabled, when there is nothing to show', async () => {
		onlineRef.current = false
		searchState.current = { q: 'hans' }
		vi.mocked(api.search.query).mockReturnValue(new Promise(() => {}))
		renderPage()
		const alert = await screen.findByRole('alert')
		expect(within(alert).getByText("You're offline")).toBeInTheDocument()
		expect(within(alert).getByRole('button', { name: 'Retry' })).toBeDisabled()
	})
})

describe('SearchPageV2 keyboard and analytics', () => {
	it('moves through results with the arrow keys and opens the highlighted one with Enter', async () => {
		const user = userEvent.setup()
		searchState.current = { q: 'hans' }
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })
		await waitFor(() => expect(trackSearchPerformed).toHaveBeenCalledTimes(1))

		await user.click(field())
		await user.keyboard('{ArrowDown}{ArrowDown}')
		const active = screen
			.getAllByRole('option')
			.find((o) => o.getAttribute('aria-selected') === 'true')
		expect(active).toHaveTextContent('Hans follow-up loop')
		expect(field()).toHaveAttribute('aria-activedescendant', active?.id)

		await user.keyboard('{Enter}')
		expect(navigateMock).toHaveBeenLastCalledWith({
			to: '/$workspaceId/loops/$loopId',
			params: { workspaceId: expect.any(String), loopId: ROW_IDS.loop },
		})
		expect(trackSearchResultOpened).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: 'search_view',
				entity_id: ROW_IDS.loop,
				entity_type: 'loop',
				result_group: 'loops',
				position: 2,
				has_query: true,
				ui_version: 'v2',
			}),
		)
		// The search is remembered with its words and pills.
		const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).find(
			(k) => k?.startsWith('maskin-recent-searches-'),
		)
		expect(JSON.parse(localStorage.getItem(key ?? '') ?? 'null')).toEqual([
			{ q: 'hans', types: [], statuses: [] },
		])
	})

	it('fires search_performed once with the v2 fields and no query text', async () => {
		searchState.current = { q: 'hans', types: 'loop' }
		renderPage()
		await screen.findByRole('option', { name: /Hans on pricing/ })
		await waitFor(() => expect(trackSearchPerformed).toHaveBeenCalledTimes(1))
		const payload = vi.mocked(trackSearchPerformed).mock.calls[0]?.[0]
		expect(payload).toMatchObject({
			surface: 'search_view',
			ui_version: 'v2',
			entry: 'url',
			pill_count: 1,
			filter_count: 1,
			type_filter: 'loop',
			result_count: 2,
		})
		expect(JSON.stringify(payload)).not.toContain('hans')
	})
})
