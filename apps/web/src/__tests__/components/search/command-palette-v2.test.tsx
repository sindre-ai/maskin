import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const navigateMock = vi.hoisted(() => vi.fn())
const setOpenMock = vi.hoisted(() => vi.fn())
const pathnameRef = vi.hoisted(() => ({ current: '/ws-1/objects' }))
const objectsRef = vi.hoisted(() => ({ current: [] as unknown[] }))
const openRef = vi.hoisted(() => ({ current: true }))
const actorsRef = vi.hoisted(() => ({ current: [] as unknown[] }))
const chatsRef = vi.hoisted(() => ({ current: [] as unknown[] }))
const loopsRef = vi.hoisted(() => ({ current: [] as unknown[] }))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
	useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
		select({ location: { pathname: pathnameRef.current } }),
}))

vi.mock('@/lib/command-palette-context', () => ({
	useCommandPalette: () => ({ open: openRef.current, setOpen: setOpenMock }),
}))

vi.mock('@/lib/api', () => ({
	api: { search: { query: vi.fn() } },
}))

vi.mock('@/hooks/use-objects', () => ({ useObjects: () => ({ data: objectsRef.current }) }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: actorsRef.current }) }))
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => ({ data: { pages: [{ conversations: chatsRef.current }] } }),
}))
vi.mock('@/hooks/use-loops', () => ({ useLoops: () => ({ data: loopsRef.current }) }))
vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: () => ({ data: { items: [] } }),
	useMarkRead: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [
		{ value: 'bet', label: 'Bets' },
		{ value: 'company', label: 'Companies' },
		{ value: 'person', label: 'People' },
	],
}))
vi.mock('@/components/shared/create-picker', () => ({ CreatePicker: () => null }))

vi.mock('@/lib/analytics', () => ({
	trackCommandPaletteOpened: vi.fn(),
	trackSearchFilterChanged: vi.fn(),
	trackSearchPerformed: vi.fn(),
	trackSearchResultOpened: vi.fn(),
}))

import { CommandPaletteV2 } from '@/components/search/command-palette-v2'
import {
	trackCommandPaletteOpened,
	trackSearchFilterChanged,
	trackSearchPerformed,
	trackSearchResultOpened,
} from '@/lib/analytics'
import { api } from '@/lib/api'
import type { SearchResponse, SearchResultRow } from '@maskin/shared'

const IDS = {
	chat: '00000000-0000-4000-8000-000000000001',
	loop: '00000000-0000-4000-8000-000000000002',
	task: '00000000-0000-4000-8000-000000000003',
	recent: '00000000-0000-4000-8000-000000000004',
}

const row = (overrides: Partial<SearchResultRow>): SearchResultRow => ({
	id: IDS.chat,
	group: 'chats',
	type: 'chat',
	title: 'Hans on pricing',
	sub: null,
	snippet: null,
	status: 'read',
	statusGroup: 'done',
	updatedAt: null,
	...overrides,
})

function response(
	rows: SearchResultRow[],
	overrides: Partial<SearchResponse> = {},
): SearchResponse {
	return {
		results: rows,
		total: rows.length,
		capped: false,
		facets: {
			types: {},
			statuses: { needs_you: 0, in_progress: 0, new: 0, done: 0, archived: 0 },
		},
		relaxed: { withoutFilters: rows.length, withoutStatuses: rows.length },
		partial: [],
		...overrides,
	}
}

const needsYouRow = row({
	id: IDS.task,
	group: 'objects',
	type: 'task',
	title: 'Review the launcher',
	status: 'in_review',
	statusGroup: 'needs_you',
})

function renderLauncher() {
	const Wrapper = createWorkspaceWrapper({ id: 'ws-1' })
	return render(<CommandPaletteV2 />, { wrapper: Wrapper })
}

const field = () => screen.getByRole('combobox', { name: 'Search or run a command' })

beforeEach(() => {
	navigateMock.mockClear()
	setOpenMock.mockClear()
	pathnameRef.current = '/ws-1/objects'
	openRef.current = true
	objectsRef.current = []
	actorsRef.current = []
	chatsRef.current = []
	loopsRef.current = []
	vi.mocked(trackCommandPaletteOpened).mockClear()
	vi.mocked(trackSearchFilterChanged).mockClear()
	vi.mocked(trackSearchPerformed).mockClear()
	vi.mocked(trackSearchResultOpened).mockClear()
	vi.mocked(api.search.query).mockReset()
	vi.mocked(api.search.query).mockImplementation(async (_ws, params) =>
		params?.statuses === 'needs_you'
			? response([needsYouRow])
			: response([
					row({}),
					row({ id: IDS.loop, group: 'loops', type: 'loop', title: 'Hans loop' }),
				]),
	)
	localStorage.clear()
})

const groupLabels = () =>
	screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))

describe('launcher with an empty field', () => {
	it('lists Needs you, Recent, Commands, Go to, then Search, and no Jump to', async () => {
		localStorage.setItem('maskin-recent-objects-ws-1', JSON.stringify([IDS.recent]))
		objectsRef.current = [
			{ id: IDS.recent, type: 'bet', title: 'Recent bet', status: 'active' } as unknown,
		]
		renderLauncher()

		await screen.findByRole('option', { name: /Review the launcher/ })
		expect(groupLabels()).toEqual(['Needs you', 'Recent', 'Commands', 'Go to', 'Search'])
		expect(screen.getByRole('option', { name: /Recent bet/ })).toBeInTheDocument()
		// Needs you comes from the shared status group, three rows at most.
		expect(api.search.query).toHaveBeenCalledWith(
			'ws-1',
			expect.objectContaining({ statuses: 'needs_you', limit: '3' }),
			expect.anything(),
		)
		expect(trackCommandPaletteOpened).toHaveBeenCalledWith({ surface: 'command_palette' })
	})

	it('does not ask the endpoint for Jump to rows until something is typed', async () => {
		renderLauncher()
		await screen.findByRole('option', { name: /Review the launcher/ })
		const calls = vi.mocked(api.search.query).mock.calls
		expect(calls.every(([, params]) => params?.statuses === 'needs_you')).toBe(true)
	})
})

describe('launcher content from the shared module', () => {
	const chiefOfStaff = { id: 'cos-1', type: 'agent', name: 'Chief of Staff' }

	it('finds New chat by its initials', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'nc')
		expect(await screen.findByRole('option', { name: /New chat/ })).toBeInTheDocument()
	})

	it('puts up to four recents, chats and loops included, after Needs you', async () => {
		localStorage.setItem('maskin-recent-objects-ws-1', JSON.stringify([IDS.recent]))
		objectsRef.current = [
			{ id: IDS.recent, type: 'bet', title: 'Recent bet', status: 'active' } as unknown,
		]
		chatsRef.current = [
			{ id: 'chat-a', title: 'Pricing chat', lastMessageAt: '2026-10-26T10:00:00Z' },
			{ id: 'chat-b', title: 'Older chat', lastMessageAt: '2026-10-25T10:00:00Z' },
		]
		loopsRef.current = [
			{ id: 'loop-a', name: 'Weekly review', updatedAt: '2026-10-26T09:00:00Z' },
			{ id: 'loop-b', name: 'Cut by the limit', updatedAt: '2026-10-20T09:00:00Z' },
		]
		const user = userEvent.setup()
		renderLauncher()

		await screen.findByRole('option', { name: /Review the launcher/ })
		expect(groupLabels().slice(0, 2)).toEqual(['Needs you', 'Recent'])
		const recent = within(screen.getByRole('group', { name: 'Recent' })).getAllByRole('option')
		expect(recent.map((option) => option.textContent)).toEqual([
			expect.stringContaining('Recent bet'),
			expect.stringContaining('Pricing chat'),
			expect.stringContaining('Older chat'),
			expect.stringContaining('Weekly review'),
		])

		await user.click(screen.getByRole('option', { name: /Weekly review/ }))
		expect(navigateMock).toHaveBeenCalledWith({ to: '/ws-1/loops/loop-a' })
	})

	it('adds a Settings row to Go to when a settings page name is typed', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'keychain')

		const option = await screen.findByRole('option', { name: /Settings › Keychain/ })
		expect(within(screen.getByRole('group', { name: 'Go to' })).getByText(/Keychain/)).toBeTruthy()
		await user.click(option)
		expect(navigateMock).toHaveBeenCalledWith({ to: '/ws-1/settings/keychain' })
	})

	it('finds Triggers in Go to', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'trigg')
		expect(
			await within(await screen.findByRole('group', { name: 'Go to' })).findByRole('option', {
				name: /Trigg\s*ers/,
			}),
		).toBeInTheDocument()
	})

	it('shows the empty-state text and an Ask row that opens a new chat with the text, unsent', async () => {
		actorsRef.current = [chiefOfStaff]
		vi.mocked(api.search.query).mockResolvedValue(response([]))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'zzzz')

		expect(
			await screen.findByText('Nothing matches “zzzz”. Try fewer words, or ask an agent.'),
		).toBeInTheDocument()
		await user.click(screen.getByRole('option', { name: /Ask Chief of Staff: “\s*zzzz\s*”/ }))
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId: 'ws-1' },
			search: { agentId: 'cos-1', agentName: 'Chief of Staff', text: 'zzzz' },
		})
		expect(setOpenMock).toHaveBeenCalledWith(false)
	})

	it('offers the Ask row for a request of three words even when there are matches', async () => {
		actorsRef.current = [chiefOfStaff]
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'what did hans say')
		await screen.findByRole('option', { name: /Hans on pricing/ })
		expect(screen.getByRole('option', { name: /Ask Chief of Staff/ })).toBeInTheDocument()
	})

	it('has no Ask row without a Chief of Staff', async () => {
		vi.mocked(api.search.query).mockResolvedValue(response([]))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'zzzz')
		await screen.findByText(/Nothing matches/)
		expect(screen.queryByRole('option', { name: /Ask Chief of Staff/ })).not.toBeInTheDocument()
	})

	it('has no Ask row while a type pill is active', async () => {
		actorsRef.current = [chiefOfStaff]
		vi.mocked(api.search.query).mockResolvedValue(response([]))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'zzzz company')
		await user.click(await screen.findByRole('button', { name: /^Filter by Companies/ }))

		expect(await screen.findByText('No results with these filters.')).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: /Ask Chief of Staff/ })).not.toBeInTheDocument()
	})
})

describe('launcher commands and hints', () => {
	it('names the create commands with the singular type name', async () => {
		renderLauncher()
		await screen.findByRole('option', { name: /Review the launcher/ })
		expect(screen.getByRole('option', { name: /New company/ })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: /New person/ })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: /New companie\b/ })).not.toBeInTheDocument()
		expect(screen.queryByRole('option', { name: /New people/ })).not.toBeInTheDocument()
	})

	it('hides the keyboard hints on touch screens and shows Ctrl off Mac', async () => {
		renderLauncher()
		await screen.findByRole('option', { name: /Review the launcher/ })
		expect(screen.getByText('Ctrl+↵ search everything')).toBeInTheDocument()
		expect(screen.getByText('↑↓ navigate').parentElement).toHaveClass(
			'max-sm:hidden',
			'pointer-coarse:hidden',
		)
	})
})

describe('launcher rows', () => {
	it('shows Untitled for a blank title and plain words for an automation trigger type', async () => {
		vi.mocked(api.search.query).mockResolvedValue(
			response([
				row({ id: IDS.task, group: 'objects', type: 'task', title: '', status: 'active' }),
				row({
					id: IDS.recent,
					group: 'automations',
					type: 'automation',
					title: 'Monday health read',
					sub: 'cron',
					status: 'on',
				}),
			]),
		)
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'monday')

		expect(await screen.findByRole('option', { name: /Untitled/ })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: /Monday health read.*Schedule/ })).toBeInTheDocument()
		expect(screen.queryByText(/cron/)).not.toBeInTheDocument()
	})
})

describe('launcher with words and pills', () => {
	it('asks for six rows, shows them under Jump to, and Enter opens the top one', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans')

		await screen.findByRole('option', { name: /Hans on pricing/ })
		expect(api.search.query).toHaveBeenCalledWith(
			'ws-1',
			expect.objectContaining({ q: 'hans', limit: '6' }),
			expect.anything(),
		)
		expect(groupLabels()).toEqual(['Jump to', 'Search'])
		await waitFor(() => expect(trackSearchPerformed).toHaveBeenCalled())
		expect(trackSearchPerformed).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'command_palette', ui_version: 'v2', result_count: 2 }),
		)

		await user.keyboard('{Enter}')
		expect(trackSearchResultOpened).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'command_palette', ui_version: 'v2', position: 1 }),
		)
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: IDS.chat },
		})
		expect(setOpenMock).toHaveBeenCalledWith(false)
	})

	it('turns a type word into a pill on Tab, hides Commands and Go to, and keeps the Tab from being trapped', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans company')

		await user.click(await screen.findByRole('button', { name: /^Filter by Companies/ }))
		expect(screen.getByRole('button', { name: /Remove filter: Companies/ })).toBeInTheDocument()
		await waitFor(() => expect(groupLabels()).not.toContain('Commands'))
		expect(groupLabels()).not.toContain('Go to')
		expect(trackSearchFilterChanged).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'command_palette', dimension: 'type', value: 'company' }),
		)
	})

	it('Tab accepts the suggestion with the keyboard', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans company')
		await screen.findByRole('button', { name: /^Filter by Companies/ })
		await user.tab()
		expect(screen.getByRole('button', { name: /Remove filter: Companies/ })).toBeInTheDocument()
		expect(field()).toHaveFocus()
	})

	it('Enter never turns a word into a pill', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans company')
		await screen.findByRole('option', { name: /Hans on pricing/ })
		await user.keyboard('{Enter}')
		expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument()
	})

	it('Cmd+Enter hands the words and the pills to the search page', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans company')
		await user.click(await screen.findByRole('button', { name: /^Filter by Companies/ }))
		await user.keyboard('{Control>}{Enter}{/Control}')

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { q: 'hans', types: 'company' },
		})
		expect(setOpenMock).toHaveBeenCalledWith(false)
		expect(JSON.parse(localStorage.getItem('maskin-recent-searches-ws-1') ?? '[]')).toEqual([
			{ q: 'hans', types: ['company'], statuses: [] },
		])
	})

	it('offers an @ menu, and Cmd+Enter hands the participant pill to the search page', async () => {
		localStorage.setItem('ff:search-chat-participant-filter', 'on')
		const PM = '00000000-0000-4000-8000-0000000000a1'
		actorsRef.current = [{ id: PM, name: 'Product Marketing', type: 'agent', isSystem: false }]
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), '@prod')
		await user.click(await screen.findByRole('option', { name: /Product Marketing/ }))
		expect(
			await screen.findByRole('button', { name: 'Remove filter: @Product Marketing' }),
		).toBeInTheDocument()
		await user.keyboard('{Control>}{Enter}{/Control}')

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { participants: PM },
		})
	})

	it('Enter on the Search row hands over too', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans')
		await screen.findByRole('option', { name: /Hans on pricing/ })
		await user.click(screen.getByRole('option', { name: /Search everything for/ }))
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { q: 'hans' },
		})
	})

	it('Esc clears the words, then the pills, then closes', async () => {
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans company')
		await user.click(await screen.findByRole('button', { name: /^Filter by Companies/ }))
		await user.type(field(), 'acme')

		await user.keyboard('{Escape}')
		expect(field()).toHaveValue('')
		expect(screen.getByRole('button', { name: /Remove filter: Companies/ })).toBeInTheDocument()
		expect(setOpenMock).not.toHaveBeenCalled()

		await user.keyboard('{Escape}')
		expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument()
		expect(setOpenMock).not.toHaveBeenCalled()

		await user.keyboard('{Escape}')
		expect(setOpenMock).toHaveBeenCalledWith(false)
	})
})

describe('launcher states', () => {
	it('shows a skeleton while the first answer is on its way', async () => {
		vi.mocked(api.search.query).mockReturnValue(new Promise(() => {}))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans')
		await waitFor(() =>
			expect(within(screen.getByRole('listbox')).getAllByText('Jump to')).toHaveLength(1),
		)
		expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0)
	})

	it('shows the search page wording on an error, with Retry', async () => {
		vi.mocked(api.search.query).mockRejectedValue(new Error('boom'))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans')

		expect(
			await screen.findByText("Couldn't run that search", {}, { timeout: 5000 }),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
	})

	it('says when some sources could not be loaded', async () => {
		vi.mocked(api.search.query).mockResolvedValue(response([row({})], { partial: ['agents'] }))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'hans')
		expect(
			await screen.findByText(/Some results couldn't be loaded, so these counts may be incomplete/),
		).toBeInTheDocument()
	})

	it('names an empty result in plain words', async () => {
		vi.mocked(api.search.query).mockResolvedValue(response([]))
		const user = userEvent.setup()
		renderLauncher()
		await user.type(field(), 'zzzz')
		expect(
			await screen.findByText('Nothing matches “zzzz”. Try fewer words, or ask an agent.'),
		).toBeInTheDocument()
	})
})

describe('⌘F', () => {
	const press = () => {
		const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
		document.dispatchEvent(event)
		return event
	}

	beforeEach(() => {
		openRef.current = false
	})

	it('is left to the browser everywhere except Search and Marketplace', () => {
		pathnameRef.current = '/ws-1/objects'
		renderLauncher()
		expect(press().defaultPrevented).toBe(false)
	})

	it('focuses the page field on Search', () => {
		pathnameRef.current = '/ws-1/search'
		renderLauncher()
		const input = document.createElement('input')
		input.setAttribute('data-search-field', 'page')
		document.body.append(input)

		expect(press().defaultPrevented).toBe(true)
		expect(input).toHaveFocus()
		input.remove()
	})

	it('focuses the catalog filter on Marketplace', () => {
		pathnameRef.current = '/ws-1/marketplace'
		renderLauncher()
		const input = document.createElement('input')
		input.setAttribute('aria-label', 'Filter marketplace')
		document.body.append(input)

		expect(press().defaultPrevented).toBe(true)
		expect(input).toHaveFocus()
		input.remove()
	})

	it('leaves the key alone on Search when the page field is not there', () => {
		pathnameRef.current = '/ws-1/search'
		renderLauncher()
		expect(press().defaultPrevented).toBe(false)
	})
})
