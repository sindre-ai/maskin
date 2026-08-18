import { NavUser } from '@/components/layout/nav-user'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()

vi.mock('@/lib/auth', () => ({
	getStoredActor: vi.fn(() => ({
		id: 'actor-1',
		name: 'Alice',
		type: 'human',
		email: 'alice@test.com',
	})),
	clearAuth: vi.fn(),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { id: 'ws-1', name: 'Test WS' }, workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@/components/ui/sidebar', () => ({
	SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({
		children,
		...props
	}: { children: React.ReactNode; [key: string]: unknown }) => (
		<button type="button" {...props}>
			{children}
		</button>
	),
	SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}))

import { clearAuth, getStoredActor } from '@/lib/auth'

describe('NavUser', () => {
	beforeEach(() => {
		vi.mocked(getStoredActor).mockReturnValue({
			id: 'actor-1',
			name: 'Alice',
			type: 'human',
			email: 'alice@test.com',
		})
	})

	it('renders actor display name', () => {
		render(<NavUser />)
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	// The initial tile now appears twice by design — on the trigger row and again
	// in the open dropdown's header — so this asserts both rather than a single
	// ambiguous match.
	it('shows the initial letter avatar on the trigger and in the dropdown', async () => {
		const user = userEvent.setup()
		render(<NavUser />)
		expect(screen.getAllByText('A')).toHaveLength(1)
		await user.click(screen.getByText('Alice'))
		expect(screen.getAllByText('A')).toHaveLength(2)
	})

	it('names the workspace under the user on the trigger row', () => {
		render(<NavUser />)
		expect(screen.getByText('Test WS')).toBeInTheDocument()
	})

	it('falls back to "User" when no stored actor', () => {
		vi.mocked(getStoredActor).mockReturnValue(null)
		render(<NavUser />)
		expect(screen.getByText('User')).toBeInTheDocument()
	})

	it('renders Settings menu item', async () => {
		const user = userEvent.setup()
		render(<NavUser />)

		await user.click(screen.getByText('Alice'))
		expect(screen.getByText('Settings')).toBeInTheDocument()
	})

	it('renders Sign out menu item', async () => {
		const user = userEvent.setup()
		render(<NavUser />)

		await user.click(screen.getByText('Alice'))
		expect(screen.getByText('Sign out')).toBeInTheDocument()
	})

	it('calls clearAuth and navigates to /login on sign out', async () => {
		const user = userEvent.setup()
		render(<NavUser />)

		await user.click(screen.getByText('Alice'))
		await user.click(screen.getByText('Sign out'))

		expect(clearAuth).toHaveBeenCalled()
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
	})
})
