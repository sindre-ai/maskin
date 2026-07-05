import { NavUser } from '@/components/layout/nav-user'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaces: () => ({
		data: [
			{ id: 'ws-1', name: 'Test WS' },
			{ id: 'ws-2', name: 'Other WS' },
		],
	}),
}))

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
	Link: ({
		to,
		params,
		children,
		onClick,
		...rest
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		onClick?: (e: React.MouseEvent) => void
		[key: string]: unknown
	}) => {
		const href =
			typeof to === 'string' ? to.replace(/\$(\w+)/g, (_match, key) => params?.[key] ?? '') : '#'
		return (
			<a href={href} onClick={onClick} {...rest}>
				{children}
			</a>
		)
	},
}))

vi.mock('@/components/ui/sidebar', () => ({
	SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({
		children,
	}: {
		children: React.ReactNode
		asChild?: boolean
		tooltip?: unknown
	}) => <div>{children}</div>,
	SidebarMenuAction: ({
		children,
		showOnHover: _showOnHover,
		asChild: _asChild,
		...props
	}: {
		children: React.ReactNode
		showOnHover?: boolean
		asChild?: boolean
		[key: string]: unknown
	}) => (
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
		mockNavigate.mockClear()
		vi.mocked(getStoredActor).mockReturnValue({
			id: 'actor-1',
			name: 'Alice',
			type: 'human',
			email: 'alice@test.com',
		})
	})

	it('renders the card as a link to the profile route', () => {
		render(<NavUser />)
		const link = screen.getByRole('link', { name: /alice/i })
		expect(link).toHaveAttribute('href', '/ws-1/profile')
	})

	it('falls back to "User" when no stored actor', () => {
		vi.mocked(getStoredActor).mockReturnValue(null)
		render(<NavUser />)
		expect(screen.getByText('User')).toBeInTheDocument()
	})

	it('does not show Settings in the kebab menu', async () => {
		const user = userEvent.setup()
		render(<NavUser />)
		await user.click(screen.getByRole('button', { name: /account menu/i }))
		expect(screen.queryByText('Settings')).not.toBeInTheDocument()
	})

	it('kebab menu shows workspace switcher and sign out', async () => {
		const user = userEvent.setup()
		render(<NavUser />)
		await user.click(screen.getByRole('button', { name: /account menu/i }))
		expect(screen.getByText('Test WS')).toBeInTheDocument()
		expect(screen.getByText('Sign out')).toBeInTheDocument()
	})

	it('calls clearAuth and navigates to /login on sign out', async () => {
		const user = userEvent.setup()
		render(<NavUser />)
		await user.click(screen.getByRole('button', { name: /account menu/i }))
		await user.click(screen.getByText('Sign out'))
		expect(clearAuth).toHaveBeenCalled()
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
	})
})
