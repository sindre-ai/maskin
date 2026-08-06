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

vi.mock('@/hooks/use-objects', () => ({
	useObjects: vi.fn(() => ({ data: [] })),
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

import { useObjects } from '@/hooks/use-objects'

describe('CommandPalette', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		installGlobalDomMocks()
		vi.mocked(useObjects).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useObjects>)
	})

	it('is not visible initially', () => {
		render(<CommandPalette />)
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('opens on Ctrl+K keyboard event', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search objects, navigate...')).toBeInTheDocument()
	})

	it('opens on Meta+K keyboard event', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Meta>}k{/Meta}')
		expect(screen.getByPlaceholderText('Search objects, navigate...')).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search objects, navigate...')).toBeInTheDocument()

		await user.keyboard('{Escape}')
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('toggles on repeated Ctrl+K', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search objects, navigate...')).toBeInTheDocument()

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
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
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('does not bind Ctrl+N or Meta+N to anything (reserved by the browser for New Window)', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}n{/Control}')
		await user.keyboard('{Meta>}n{/Meta}')

		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('Ctrl+J opens the chat sheet without opening the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}j{/Control}')

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('Meta+J opens the chat sheet without opening the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Meta>}j{/Meta}')

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('Ctrl+J closes the palette if it is already open', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		expect(screen.getByPlaceholderText('Search objects, navigate...')).toBeInTheDocument()

		await user.keyboard('{Control>}j{/Control}')

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})

	it('Chat with agents action opens the sheet and closes the palette', async () => {
		const user = userEvent.setup()
		render(<CommandPalette />)

		await user.keyboard('{Control>}k{/Control}')
		await user.click(screen.getByText('Chat with agents…'))

		expect(mockSetChatOpen).toHaveBeenCalledWith(true)
		expect(screen.queryByPlaceholderText('Search objects, navigate...')).not.toBeInTheDocument()
	})
})
