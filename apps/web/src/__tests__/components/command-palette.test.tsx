import { CommandPalette } from '@/components/command-palette'
import type { SearchRow } from '@/hooks/use-workspace-search'
import { render, screen } from '@testing-library/react'
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
const markReadMutate = vi.fn()
const toastMock = vi.fn()

vi.mock('@/lib/analytics', () => ({
	trackCommandPaletteOpened: (p: unknown) => trackCommandPaletteOpenedMock(p),
	trackSearchResultOpened: (p: unknown) => trackSearchResultOpenedMock(p),
}))

vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toastMock(...args) }))

vi.mock('@/hooks/use-objects', () => ({
	useObjects: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/hooks/use-workspace-search', () => ({
	useWorkspaceSearch: vi.fn(() => ({ rows: [] })),
}))

vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
	],
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: vi.fn(() => ({ data: { items: [] } })),
	useMarkRead: () => ({ mutate: markReadMutate }),
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
		vi.mocked(useObjects).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useObjects>)
		vi.mocked(useWorkspaceSearch).mockReturnValue({ rows: [] } as unknown as ReturnType<
			typeof useWorkspaceSearch
		>)
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

		expect(trackSearchResultOpenedMock).toHaveBeenCalledWith({
			entity_id: 'obj-1',
			entity_type: 'insight',
			surface: 'command_palette',
		})
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1/objects/obj-1' })
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

	it('Mark all read marks every unread entity read', async () => {
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

		expect(markReadMutate).toHaveBeenCalledTimes(1)
		expect(markReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 9,
		})
		expect(toastMock).toHaveBeenCalledWith('All caught up')
	})

	it('jumps to a non-object workspace row', async () => {
		vi.mocked(useWorkspaceSearch).mockReturnValue({
			rows: [buildSearchRow()],
		} as unknown as ReturnType<typeof useWorkspaceSearch>)
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Run a command or jump to…'), 'billing')
		// The typed query is highlighted, so the title is split across nodes —
		// match on the unhighlighted tail.
		await user.click(await screen.findByText(/catch-up/))

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: 'chat-1' },
		})
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
		expect(screen.getByText('⌘↵ search everything')).toBeInTheDocument()
		expect(screen.getByText('esc closes')).toBeInTheDocument()
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
