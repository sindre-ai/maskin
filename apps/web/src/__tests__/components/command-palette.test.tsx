import { CommandPalette } from '@/components/command-palette'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../factories'

// cmdk uses ResizeObserver and scrollIntoView internally
global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

Element.prototype.scrollIntoView = vi.fn()

const mockNavigate = vi.fn()

vi.mock('@/hooks/use-objects', () => ({
	useObjects: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
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
		expect(screen.getByText('Activity Feed')).toBeInTheDocument()
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

	it('Ctrl+N navigates to create new object', async () => {
		const user = userEvent.setup()
		// Mock crypto.randomUUID
		const mockUUID = '00000000-0000-0000-0000-000000000001'
		vi.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID as `${string}-${string}-${string}-${string}-${string}`)

		render(<CommandPalette />)
		await user.keyboard('{Control>}n{/Control}')

		expect(mockNavigate).toHaveBeenCalledWith({ to: `/ws-1/objects/${mockUUID}` })
		vi.restoreAllMocks()
	})
})
