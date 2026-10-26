import { CommandPalette } from '@/components/command-palette'
import type { SearchRow } from '@/hooks/use-workspace-search'
import { pushRecentObject } from '@/lib/search-recents'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { buildObjectResponse } from '../factories'

// cmdk uses ResizeObserver and scrollIntoView internally. Established here and
// re-established in beforeEach so `vi.restoreAllMocks()` in any single test
// can't strip the implementation for later tests.
function installGlobalDomMocks() {
	global.ResizeObserver = vi.fn().mockImplementation(() => ({
		observe: vi.fn(),
		unobserve: vi.fn(),
		disconnect: vi.fn(),
	}))
	Element.prototype.scrollIntoView = vi.fn()
}
installGlobalDomMocks()

const mockNavigate = vi.fn()
const trackCommandPaletteOpenedMock = vi.fn()
const trackSearchResultOpenedMock = vi.fn()
const trackSearchPerformedMock = vi.fn()
const markReadMutateAsync = vi.fn(() => Promise.resolve())
const toastMock = vi.fn()
const toastErrorMock = vi.fn()

vi.mock('@/lib/analytics', () => ({
	trackCommandPaletteOpened: (p: unknown) => trackCommandPaletteOpenedMock(p),
	trackSearchResultOpened: (p: unknown) => trackSearchResultOpenedMock(p),
	trackSearchPerformed: (p: unknown) => trackSearchPerformedMock(p),
}))

vi.mock('sonner', () => ({
	toast: Object.assign((...args: unknown[]) => toastMock(...args), {
		error: (...args: unknown[]) => toastErrorMock(...args),
	}),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObjects: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/hooks/use-workspace-search', () => ({
	useWorkspaceSearch: vi.fn(() => ({ rows: [], isSettled: true })),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: vi.fn(() => ({ data: undefined })),
}))

vi.mock('@/hooks/use-loops', () => ({
	useLoops: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
	],
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: vi.fn(() => ({ data: { items: [] } })),
	useMarkRead: () => ({ mutateAsync: markReadMutateAsync }),
}))

// The create surface is exercised on its own; here we only care that a create
// command opens it with the right seed.
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: ({ defaultType, defaultObjectSubtype }: Record<string, unknown>) => (
		<div data-testid="create-picker">{`${defaultType}:${defaultObjectSubtype ?? ''}`}</div>
	),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

// Stand in for CommandPaletteProvider — real useState so open/close behavior
// (driven by CommandPalette's own keydown handlers) works exactly like the
// real context, without needing to render the provider tree in these tests.
vi.mock('@/lib/command-palette-context', () => ({
	useCommandPalette: () => {
		const [open, setOpen] = useState(false)
		return { open, setOpen }
	},
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
	Link: ({ children, ...rest }: { children: React.ReactNode; to?: string }) => (
		<a href={rest.to} {...rest}>
			{children}
		</a>
	),
}))

import { useActors } from '@/hooks/use-actors'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useLoops } from '@/hooks/use-loops'
import { useObjects } from '@/hooks/use-objects'
import { useUnread } from '@/hooks/use-subscriptions'
import { useWorkspaceSearch } from '@/hooks/use-workspace-search'

function buildSearchRow(overrides: Partial<SearchRow> = {}): SearchRow {
	return {
		id: 'chat-1',
		group: 'chats',
		kind: 'CHAT',
		title: 'Billing catch-up',
		sub: 'Chief of Staff',
		snippet: '',
		to: '/$workspaceId/chats/$conversationId',
		params: { workspaceId: 'ws-1', conversationId: 'chat-1' },
		...overrides,
	}
}

describe('CommandPalette', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		installGlobalDomMocks()
		localStorage.clear()
		vi.mocked(useObjects).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useObjects>)
		vi.mocked(useActors).mockReturnValue({
			data: [{ id: 'cos-1', type: 'agent', name: 'Chief of Staff' }],
		} as unknown as ReturnType<typeof useActors>)
		vi.mocked(useConversationsInfinite).mockReturnValue({
			data: undefined,
		} as unknown as ReturnType<typeof useConversationsInfinite>)
		vi.mocked(useLoops).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useLoops>)
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [],
			isSettled: true,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		vi.mocked(useUnread).mockReturnValue({ data: { items: [] } } as unknown as ReturnType<
			typeof useUnread
		>)
	})

	it('is not visible initially', () => {
		render(<CommandPalette />)
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('opens on Ctrl+K keyboard event', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()
	})

	it('opens on Meta+K keyboard event', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Meta>}k{/Meta}')
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()

		await user.keyboard('{Escape}')
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('toggles on repeated Ctrl+K', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('fires command_palette_opened once per open with the command_palette surface', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()
		expect(trackCommandPaletteOpenedMock).toHaveBeenCalledTimes(1)
		expect(trackCommandPaletteOpenedMock).toHaveBeenCalledWith({ surface: 'command_palette' })

		await user.keyboard('{Control>}k{/Control}')
		await user.keyboard('{Control>}k{/Control}')
		expect(trackCommandPaletteOpenedMock).toHaveBeenCalledTimes(2)
	})

	it('fires search_result_opened with the entity contract when a result is opened', async () => {
		const objects = [buildObjectResponse({ id: 'obj-1', title: 'Alpha Insight', type: 'insight' })]
		vi.mocked(useObjects).mockReturnValue({ data: objects } as ReturnType<typeof useObjects>)
		const user = userEvent.setup()

		render(<CommandPalette />)
		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Alpha Insight'))

		// The empty-query Jump to list is not a search: no search id, has_query
		// false, counted against the six-row list it was shown in.
		expect(trackSearchResultOpenedMock).toHaveBeenCalledWith({
			entity_id: 'obj-1',
			entity_type: 'insight',
			surface: 'command_palette',
			search_id: null,
			has_query: false,
			result_count: 1,
			position: 1,
			result_group: 'objects',
		})
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/objects/obj-1' })
	})

	it('fires one search_performed per settled query with counts and no query text', async () => {
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [buildSearchRow()],
			total: 4,
			isSettled: true,
			isError: false,
			isPartial: false,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(trackSearchPerformedMock).not.toHaveBeenCalled()
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'billing  catch up')
		await waitFor(() => expect(trackSearchPerformedMock).toHaveBeenCalledTimes(1))

		const payload = trackSearchPerformedMock.mock.calls[0]?.[0]
		expect(payload).toEqual({
			surface: 'command_palette',
			search_id: expect.any(String),
			result_count: 4,
			is_partial: false,
			query_length: 'billing  catch up'.length,
			words_count: 3,
			type_filter: null,
			status_filter: null,
		})
		expect(JSON.stringify(payload)).not.toContain('billing')
	})

	it('fires no search_performed while results are unsettled or the search failed', async () => {
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [],
			total: 0,
			isSettled: false,
			isError: false,
			isPartial: false,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'zzzz')
		await screen.findByText(/Search everything for/)
		await new Promise((resolve) => setTimeout(resolve, 400))
		expect(trackSearchPerformedMock).not.toHaveBeenCalled()

		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [],
			total: 0,
			isSettled: true,
			isError: true,
			isPartial: false,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'y')
		await new Promise((resolve) => setTimeout(resolve, 400))
		expect(trackSearchPerformedMock).not.toHaveBeenCalled()
	})

	it('lists the commands group', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByText('New chat')).toBeInTheDocument()
		expect(screen.getByText('New insight')).toBeInTheDocument()
		expect(screen.getByText('New bet')).toBeInTheDocument()
		expect(screen.getByText('New loop')).toBeInTheDocument()
		expect(screen.getByText('New agent')).toBeInTheDocument()
		expect(screen.getByText('Mark all read')).toBeInTheDocument()
	})

	it('goes to every primary view — and never to a retired label', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		for (const view of [
			'For you',
			'Chats',
			'Loops',
			'Agents',
			'Objects',
			'Marketplace',
			'Settings',
		]) {
			expect(screen.getByText(view)).toBeInTheDocument()
		}
		expect(screen.queryByText('Bets Dashboard')).not.toBeInTheDocument()
		expect(screen.queryByText('All Objects')).not.toBeInTheDocument()
	})

	it('navigates on a Go to item and closes the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Loops'))

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/loops' })
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('opens the create surface seeded with the picked object type', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('New bet'))

		expect(screen.getByTestId('create-picker')).toHaveTextContent('object:bet')
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('Mark all read marks every unread entity read and waits before reporting success', async () => {
		vi.mocked(useUnread).mockReturnValue({
			data: {
				items: [
					{ entity_type: 'object', entity_id: 'obj-1', unread_count: 2, latest_event_id: 9 },
					{ entity_type: 'object', entity_id: 'obj-2', unread_count: 0, latest_event_id: 4 },
				],
			},
		} as unknown as ReturnType<typeof useUnread>)
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Mark all read'))

		expect(markReadMutateAsync).toHaveBeenCalledTimes(1)
		expect(markReadMutateAsync).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 9,
		})
		// The success toast only fires once the mutation has actually settled —
		// not synchronously alongside firing it off.
		await vi.waitFor(() => expect(toastMock).toHaveBeenCalledWith('All caught up'))
	})

	it('Mark all read reports a failure count instead of a false "all caught up"', async () => {
		markReadMutateAsync.mockRejectedValueOnce(new Error('network error'))
		vi.mocked(useUnread).mockReturnValue({
			data: {
				items: [
					{ entity_type: 'object', entity_id: 'obj-1', unread_count: 2, latest_event_id: 9 },
					{ entity_type: 'object', entity_id: 'obj-2', unread_count: 1, latest_event_id: 4 },
				],
			},
		} as unknown as ReturnType<typeof useUnread>)
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Mark all read'))

		await vi.waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				'1 of 2 marked read',
				expect.objectContaining({ description: expect.any(String) }),
			),
		)
		expect(toastMock).not.toHaveBeenCalledWith('All caught up')
	})

	it('jumps to a non-object workspace row', async () => {
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [buildSearchRow()],
			total: 1,
			isSettled: true,
			isError: false,
			isPartial: false,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'billing')
		// The typed query is highlighted, so the title is split across nodes —
		// match on the unhighlighted tail.
		// Wait for the settled search so the open can be tied to it.
		await waitFor(() => expect(trackSearchPerformedMock).toHaveBeenCalledTimes(1))
		await user.click(await screen.findByText(/catch-up/))

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: 'chat-1' },
		})
		// A chat row now reports its open too, tied to the search it came from.
		expect(trackSearchResultOpenedMock).toHaveBeenCalledWith({
			entity_id: 'chat-1',
			entity_type: 'conversation',
			surface: 'command_palette',
			search_id: expect.any(String),
			has_query: true,
			result_count: 1,
			position: 1,
			result_group: 'chats',
		})
	})

	it('a short query does not pull in every command or view through the group names', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		// "ma" sits inside "command" and "to" inside "go to"; neither may list every row.
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'ma')

		// The typed letters are wrapped in <mark>, which splits each title across
		// elements and puts a space in its accessible name ("Ma rk all read"), so
		// read the rows' own text instead.
		const rows = screen.getAllByRole('option').map((option) => option.textContent ?? '')
		expect(rows.some((row) => row.includes('New chat'))).toBe(false)
		expect(rows.some((row) => row.includes('Mark all read'))).toBe(true)
		expect(rows.some((row) => row.includes('Marketplace'))).toBe(true)
		expect(screen.queryByText('Chats')).not.toBeInTheDocument()
	})

	it('typing the start of "command" still lists the commands', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'comm')

		expect(screen.getByText('New chat')).toBeInTheDocument()
		expect(screen.getByText('New bet')).toBeInTheDocument()
	})

	it('finds a command by its initials', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'nc')

		const rows = screen.getAllByRole('option').map((option) => option.textContent ?? '')
		expect(rows.some((row) => row.includes('New chat'))).toBe(true)
	})

	it('shows the last things opened when the field is empty, not the list order', async () => {
		const user = userEvent.setup()
		pushRecentObject('ws-1', 'o-old')
		pushRecentObject('ws-1', 'o-new')
		vi.mocked(useObjects).mockReturnValue({
			data: [
				buildObjectResponse({ id: 'o-unopened', title: 'First in list', type: 'task' }),
				buildObjectResponse({ id: 'o-old', title: 'Opened earlier', type: 'task' }),
				buildObjectResponse({ id: 'o-new', title: 'Opened last', type: 'bet' }),
			],
		} as unknown as ReturnType<typeof useObjects>)
		vi.mocked(useConversationsInfinite).mockReturnValue({
			data: {
				pages: [
					{
						conversations: [
							{ id: 'c1', title: 'Weekly sync', lastMessageAt: '2026-10-25T10:00:00Z' },
						],
					},
				],
			},
		} as unknown as ReturnType<typeof useConversationsInfinite>)
		vi.mocked(useLoops).mockReturnValue({
			data: [{ id: 'l1', name: 'Daily digest', updatedAt: '2026-10-24T10:00:00Z' }],
		} as unknown as ReturnType<typeof useLoops>)
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')

		expect(screen.getByText('Recent')).toBeInTheDocument()
		const rows = screen.getAllByRole('option').map((option) => option.textContent ?? '')
		expect(rows.slice(0, 4).map((row) => row.replace(/BET|TASK|CHAT|LOOP|↵/g, ''))).toEqual([
			'Opened last',
			'Opened earlier',
			'Weekly sync',
			'Daily digest',
		])
		expect(screen.queryByText('First in list')).not.toBeInTheDocument()

		await user.click(screen.getByText('Weekly sync'))
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/chats/c1' })
	})

	it('has no Recent group when nothing was opened and there are no chats or loops', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')

		expect(screen.queryByText('Recent')).not.toBeInTheDocument()
	})

	it('adds a Settings row for a settings page name, and no more than four', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		const input = screen.getByPlaceholderText('Run a command or jump to…')
		await user.type(input, 'keychain')
		await user.click(screen.getByText('Settings › Keychain'))
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/settings/keychain' })

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'e')
		const settingsRows = screen
			.getAllByRole('option')
			.filter((option) => (option.textContent ?? '').includes('Settings ›'))
		expect(settingsRows).toHaveLength(4)
	})

	it('goes to Triggers', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Triggers'))

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/triggers' })
	})

	it('with no results shows the empty state and ends on an Ask Chief of Staff row that sends nothing', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'qzxv')

		expect(
			screen.getByText('Nothing matches “qzxv”. Try fewer words, or ask an agent.'),
		).toBeInTheDocument()
		expect(screen.getByText(/no matches, try fewer words or other types/)).toBeInTheDocument()
		const options = screen.getAllByRole('option')
		const last = options[options.length - 1]
		expect(last.textContent).toContain('Ask Chief of Staff')

		await user.click(last)
		expect(mockNavigate).toHaveBeenCalledTimes(1)
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId: 'ws-1' },
			search: { agentId: 'cos-1', agentName: 'Chief of Staff', text: 'qzxv' },
		})
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('offers the Ask row for three words and for a trailing question mark, but not for two words', async () => {
		const user = userEvent.setup()
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [buildSearchRow({ title: 'plan' })],
			isSettled: true,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		render(<CommandPalette />)
		await user.keyboard('{Control>}k{/Control}')
		const input = screen.getByPlaceholderText('Run a command or jump to…')
		const askShown = () =>
			screen
				.getAllByRole('option')
				.some((o) => (o.textContent ?? '').includes('Ask Chief of Staff'))

		await user.type(input, 'launch plan')
		expect(askShown()).toBe(false)

		await user.type(input, ' now')
		expect(askShown()).toBe(true)

		await user.clear(input)
		await user.type(input, 'plan?')
		expect(askShown()).toBe(true)
	})

	it('hides the Ask row when the workspace has no Chief of Staff', async () => {
		const user = userEvent.setup()
		vi.mocked(useActors).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useActors>)
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'qzxv')

		expect(screen.queryByText(/Ask Chief of Staff/)).not.toBeInTheDocument()
	})

	it('the terminal Search row hands the typed query to /search', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'alpha')
		await user.click(await screen.findByText(/Search everything for/))

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { q: 'alpha' },
		})
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('Ctrl+Enter hands the typed query to /search — the footer advertises it', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'alpha')
		await user.keyboard('{Control>}{Enter}{/Control}')

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { q: 'alpha' },
		})
	})

	// With nothing typed there is no query to search, so ⌘↵ falls through to
	// cmdk's own Enter — it runs the highlighted item instead of navigating to
	// an empty /search.
	it('does not navigate to an empty search when Ctrl+Enter is pressed with no query', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		mockNavigate.mockClear()
		await user.keyboard('{Control>}{Enter}{/Control}')

		expect(mockNavigate).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: '/$workspaceId/search', search: { q: '' } }),
		)
	})

	it('always shows the keyboard hint footer', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')

		expect(screen.getByText('↑↓ navigate')).toBeInTheDocument()
		expect(screen.getByText('Ctrl+↵ search everything')).toBeInTheDocument()
		expect(screen.getByText('esc closes')).toBeInTheDocument()
	})

	it('shows the Mac key in the footer on a Mac', async () => {
		const user = userEvent.setup()
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
		)
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')

		expect(screen.getByText('⌘↵ search everything')).toBeInTheDocument()
		vi.restoreAllMocks()
	})

	it('leaves Ctrl+F and Meta+F to the browser find', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)
		const seen: boolean[] = []
		const record = (e: KeyboardEvent) => seen.push(e.defaultPrevented)
		// Registered after the palette's own listener, so it sees the final state.
		document.addEventListener('keydown', record)

		await user.keyboard('{Control>}f{/Control}')
		await user.keyboard('{Meta>}f{/Meta}')
		document.removeEventListener('keydown', record)

		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
		expect(seen.every((prevented) => !prevented)).toBe(true)
	})

	it('fetches nothing until the palette opens', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)
		expect(useWorkspaceSearch).toHaveBeenLastCalledWith(
			'ws-1',
			expect.objectContaining({ enabled: false }),
		)

		await user.keyboard('{Control>}k{/Control}')

		expect(useWorkspaceSearch).toHaveBeenLastCalledWith(
			'ws-1',
			expect.objectContaining({ enabled: true }),
		)
	})

	it('filters the local lists on the keystroke and debounces only the server query', async () => {
		// Fire-and-forget typing (delay: null) so the debounce has no time to land.
		const user = userEvent.setup({ delay: null })
		render(<CommandPalette />)
		await user.keyboard('{Control>}k{/Control}')

		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'mark')

		const calls = vi.mocked(useWorkspaceSearch).mock.calls
		const last = calls[calls.length - 1]?.[1]
		expect(last).toMatchObject({ q: 'mark' })
		expect(calls.some(([, params]) => params.q === 'mark' && params.serverQ !== 'mark')).toBe(true)
		// The Commands group already narrowed to the matching row. The typed letters
		// are wrapped in <mark>, so read the rows' own text, not a single text node.
		const rows = screen.getAllByRole('option').map((option) => option.textContent ?? '')
		expect(rows.some((row) => row.includes('Mark all read'))).toBe(true)
		expect(rows.some((row) => row.includes('New chat'))).toBe(false)
	})

	it('does nothing on Enter for the Search row until the results have settled', async () => {
		const user = userEvent.setup()
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [],
			isSettled: false,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		render(<CommandPalette />)
		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'alpha')

		expect(screen.getByTestId('palette-progress')).toBeInTheDocument()
		await user.keyboard('{Enter}')
		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()

		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [],
			isSettled: true,
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'x')
		expect(screen.queryByTestId('palette-progress')).not.toBeInTheDocument()
		await user.keyboard('{Enter}')
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { q: 'alphax' },
		})
	})

	it('does not bind Ctrl+N or Meta+N to anything (reserved by the browser for New Window)', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}n{/Control}')
		await user.keyboard('{Meta>}n{/Meta}')

		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('Ctrl+J navigates to a new chat without opening the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}j{/Control}')

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/chats/new' })
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('Meta+J navigates to a new chat without opening the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Meta>}j{/Meta}')

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/chats/new' })
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('Ctrl+J closes the palette if it is already open', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Run a command or jump to…')).toBeInTheDocument()

		await user.keyboard('{Control>}j{/Control}')

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/chats/new' })
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})

	it('New chat navigates to a new chat and closes the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('New chat'))

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/chats/new' })
		expect(screen.queryByPlaceholderText('Run a command or jump to…')).not.toBeInTheDocument()
	})
})
