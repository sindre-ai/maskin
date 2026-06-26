import { WorkspaceSwitcher } from '@/components/layout/workspace-switcher'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'

const mockNavigate = vi.fn()
const mockInvalidateQueries = vi.fn()

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaces: vi.fn(),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@tanstack/react-query', () => ({
	useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
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

import { useWorkspaces } from '@/hooks/use-workspaces'

type UseWorkspacesReturn = ReturnType<typeof useWorkspaces>

function mockUseWorkspaces(value: Partial<UseWorkspacesReturn>) {
	vi.mocked(useWorkspaces).mockReturnValue(value as UseWorkspacesReturn)
}

describe('WorkspaceSwitcher', () => {
	beforeEach(() => {
		mockNavigate.mockClear()
		mockInvalidateQueries.mockClear()
	})

	it('AC-U1: renders the current workspace name in the pill', () => {
		mockUseWorkspaces({
			isPending: false,
			isError: false,
			data: [
				buildWorkspaceWithRole({ id: 'ws-1', name: 'Acme HQ', role: 'admin' }),
				buildWorkspaceWithRole({ id: 'ws-2', name: 'Side Quest', role: 'member' }),
			],
		})
		render(<WorkspaceSwitcher />)
		expect(screen.getByText('Acme HQ')).toBeInTheDocument()
	})

	it('AC-U2: clicking the pill lists every membership with the current one marked', async () => {
		mockUseWorkspaces({
			isPending: false,
			isError: false,
			data: [
				buildWorkspaceWithRole({ id: 'ws-1', name: 'Acme HQ', role: 'admin' }),
				buildWorkspaceWithRole({ id: 'ws-2', name: 'Side Quest', role: 'member' }),
			],
		})
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />)

		await user.click(screen.getByRole('button', { name: /Acme HQ/ }))

		expect(screen.getByRole('menuitem', { name: /Side Quest/ })).toBeInTheDocument()
		const currentItem = screen.getByRole('menuitem', { name: /Acme HQ/ })
		expect(currentItem).toHaveAttribute('aria-current', 'true')
	})

	it('AC-U3 + AC-T4: selecting another workspace navigates and invalidates every query', async () => {
		mockUseWorkspaces({
			isPending: false,
			isError: false,
			data: [
				buildWorkspaceWithRole({ id: 'ws-1', name: 'Acme HQ', role: 'admin' }),
				buildWorkspaceWithRole({ id: 'ws-2', name: 'Side Quest', role: 'member' }),
			],
		})
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />)

		await user.click(screen.getByRole('button', { name: /Acme HQ/ }))
		await user.click(screen.getByRole('menuitem', { name: /Side Quest/ }))

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId',
			params: { workspaceId: 'ws-2' },
		})
		// No filter args => every cached query is invalidated, including the
		// previous workspace's sessions/unread/modules/objects.
		expect(mockInvalidateQueries).toHaveBeenCalledWith()
	})

	it('AC-U3: selecting the current workspace does not navigate or invalidate', async () => {
		mockUseWorkspaces({
			isPending: false,
			isError: false,
			data: [buildWorkspaceWithRole({ id: 'ws-1', name: 'Acme HQ', role: 'admin' })],
		})
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />)

		await user.click(screen.getByRole('button', { name: /Acme HQ/ }))
		await user.click(screen.getByRole('menuitem', { name: /Acme HQ/ }))

		expect(mockNavigate).not.toHaveBeenCalled()
		expect(mockInvalidateQueries).not.toHaveBeenCalled()
	})

	it('AC-T2: shows a skeleton pill while workspaces are loading', () => {
		mockUseWorkspaces({ isPending: true, isError: false, data: undefined })
		const { container } = render(<WorkspaceSwitcher />)
		expect(container.querySelector('.animate-pulse')).not.toBeNull()
		// Pill itself is rendered (shell does not collapse).
		expect(screen.getByLabelText('Loading workspace')).toBeInTheDocument()
	})

	it('AC-T2: falls back to a URL-derived label when the workspaces query errors', () => {
		mockUseWorkspaces({ isPending: false, isError: true, data: undefined })
		render(<WorkspaceSwitcher />)
		// `ws-1` is the URL workspaceId from the mocked context — the pill shows
		// a derived label rather than collapsing.
		expect(screen.getByText(/Workspace ws-1/)).toBeInTheDocument()
	})
})
