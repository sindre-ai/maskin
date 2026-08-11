import { CommandPalette } from '@/components/command-palette'
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
const mockSetChatOpen = vi.fn()
const trackCommandPaletteOpenedMock = vi.fn()
const trackSearchResultOpenedMock = vi.fn()

vi.mock('@/lib/analytics', () => ({
	trackCommandPaletteOpened: (p: unknown) => trackCommandPaletteOpenedMock(p),
	trackSearchResultOpened: (p: unknown) => trackSearchResultOpenedMock(p),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObjects: vi.fn(() => ({ data: [] })),
	useSearchObjects: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ setOpen: mockSetChatOpen }),
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

import { useObjects, useSearchObjects } from '@/hooks/use-objects'

describe('CommandPalette', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		installGlobalDomMocks()
		vi.mocked(useObjects).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useObjects>)
		vi.mocked(useSearchObjects).mockReturnValue({ data: [] } as unknown as ReturnType<
			typeof useSearchObjects
		>)
	})

	it('is not visible initially', () => {
		render(<CommandPalette />)
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('opens on Ctrl+K keyboard event', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search or jump to…')).toBeInTheDocument()
	})

	it('opens on Meta+K keyboard event', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Meta>}k{/Meta}')
		expect(screen.getByPlaceholderText('Search or jump to…')).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search or jump to…')).toBeInTheDocument()

		await user.keyboard('{Escape}')
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('toggles on repeated Ctrl+K', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search or jump to…')).toBeInTheDocument()

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('fires command_palette_opened once per open with the command_palette surface', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		// Open via ⌘K from the current route (the keydown listener is global).
		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search or jump to…')).toBeInTheDocument()
		expect(trackCommandPaletteOpenedMock).toHaveBeenCalledTimes(1)
		expect(trackCommandPaletteOpenedMock).toHaveBeenCalledWith({ surface: 'command_palette' })

		// Close, then open again: a new open transition fires, but never twice
		// while already open.
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

	it('shows navigation items', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByText('Bets Dashboard')).toBeInTheDocument()
		expect(screen.getByText('All Objects')).toBeInTheDocument()
		expect(screen.getByText('Agents')).toBeInTheDocument()
	})

	it('shows objects from useObjects data', async () => {
		const objects = [
			buildObjectResponse({ id: 'obj-1', title: 'Alpha Insight', type: 'insight' }),
			buildObjectResponse({ id: 'obj-2', title: 'Beta Bet', type: 'bet' }),
		]
		vi.mocked(useObjects).mockReturnValue({ data: objects } as ReturnType<typeof useObjects>)
		const user = userEvent.setup()

		render(<CommandPalette />)
		await user.keyboard('{Control>}k{/Control}')

		expect(screen.getByText('Alpha Insight')).toBeInTheDocument()
		expect(screen.getByText('Beta Bet')).toBeInTheDocument()
	})

	it('navigates on item select and closes palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Bets Dashboard'))

		expect(mockNavigate).toHaveBeenCalledWith({ to: '/ws-1' })
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('See all footer navigates to /search with the typed query and closes the palette', async () => {
		const user = userEvent.setup()
		vi.mocked(useSearchObjects).mockReturnValue({
			data: [buildObjectResponse({ id: 'obj-1', title: 'Alpha Insight', type: 'insight' })],
		} as unknown as ReturnType<typeof useSearchObjects>)
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.type(screen.getByPlaceholderText('Search or jump to…'), 'alpha')

		await user.click(await screen.findByRole('button', { name: /See all/ }))

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/search',
			params: { workspaceId: 'ws-1' },
			search: { q: 'alpha' },
		})
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('does not bind Ctrl+N or Meta+N to anything (reserved by the browser for New Window)', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}n{/Control}')
		await user.keyboard('{Meta>}n{/Meta}')

		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('Ctrl+J opens the chat sheet without opening the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}j{/Control}')

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('Meta+J opens the chat sheet without opening the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Meta>}j{/Meta}')

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('Ctrl+J closes the palette if it is already open', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search or jump to…')).toBeInTheDocument()

		await user.keyboard('{Control>}j{/Control}')

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})

	it('Chat with agents action opens the sheet and closes the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Chat with agents…'))

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument()
	})
})
