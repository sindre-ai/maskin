import { AppSidebar } from '@/components/layout/sidebar'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Activity, Bot, type LucideIcon, Zap } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

const makePage = (id: string, label: string, to: string, icon: LucideIcon, exact?: true) => ({
	id,
	label,
	to,
	icon,
	exact,
	description: '',
	category: 'workspace' as const,
})

vi.mock('@/hooks/use-pinned-pages', () => ({
	usePinnedPages: vi.fn(() => ({
		pinnedPages: [
			makePage('pulse', 'Pulse', '/$workspaceId', Zap, true),
			makePage('threads', 'Threads', '/$workspaceId/threads', Activity),
			makePage('activity', 'Activity', '/$workspaceId/activity', Bot),
		],
		allPages: [],
		isEditing: false,
		setEditing: vi.fn(),
		pin: vi.fn(),
		unpin: vi.fn(),
		isPinned: vi.fn(() => false),
		reorder: vi.fn(),
	})),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const setSindreOpen = vi.fn()
vi.mock('@/lib/sindre-context', () => ({
	useSindre: () => ({ setOpen: setSindreOpen }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		useMatchRoute: () => () => false,
	}
})

const setOpenMobile = vi.fn()
vi.mock('@/components/ui/sidebar', () => ({
	Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({
		children,
		onClick,
		tooltip,
	}: {
		children: React.ReactNode
		onClick?: () => void
		tooltip?: string
	}) => (
		<button type="button" onClick={onClick} data-tooltip={tooltip}>
			{children}
		</button>
	),
	SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarRail: () => <div />,
	SidebarTrigger: () => <button type="button">Toggle</button>,
	useSidebar: () => ({ setOpenMobile }),
}))

vi.mock('@/components/agents/agent-pulse', () => ({
	AgentPulse: () => <div data-testid="agent-pulse">AgentPulse</div>,
}))

vi.mock('@/components/layout/nav-user', () => ({
	NavUser: () => <div data-testid="nav-user">NavUser</div>,
}))

import { usePinnedPages } from '@/hooks/use-pinned-pages'

describe('AppSidebar', () => {
	it('renders pinned pages from the hook', () => {
		render(<AppSidebar />)
		expect(screen.getByText('Pulse')).toBeInTheDocument()
		expect(screen.getByText('Threads')).toBeInTheDocument()
		expect(screen.getByText('Activity')).toBeInTheDocument()
	})

	it('shows "Pinned" section label', () => {
		render(<AppSidebar />)
		expect(screen.getByText('Pinned')).toBeInTheDocument()
	})

	it('shows "All" link and "Edit" button', () => {
		render(<AppSidebar />)
		expect(screen.getByText('All')).toBeInTheDocument()
		expect(screen.getByText('Edit')).toBeInTheDocument()
	})

	it('shows "All pages" always-visible link', () => {
		render(<AppSidebar />)
		expect(screen.getByText('All pages')).toBeInTheDocument()
	})

	it('shows unpin buttons and "Done" in edit mode', () => {
		vi.mocked(usePinnedPages).mockReturnValueOnce({
			pinnedPages: [makePage('pulse', 'Pulse', '/$workspaceId', Zap, true)],
			allPages: [],
			isEditing: true,
			setEditing: vi.fn(),
			pin: vi.fn(),
			unpin: vi.fn(),
			isPinned: vi.fn(() => true),
			reorder: vi.fn(),
		})
		render(<AppSidebar />)
		expect(screen.getByText('Done')).toBeInTheDocument()
		expect(screen.getByLabelText('Unpin Pulse')).toBeInTheDocument()
	})

	it('calls unpin when unpin button is clicked', async () => {
		const unpin = vi.fn()
		vi.mocked(usePinnedPages).mockReturnValueOnce({
			pinnedPages: [makePage('pulse', 'Pulse', '/$workspaceId', Zap, true)],
			allPages: [],
			isEditing: true,
			setEditing: vi.fn(),
			pin: vi.fn(),
			unpin,
			isPinned: vi.fn(() => true),
			reorder: vi.fn(),
		})
		render(<AppSidebar />)
		await userEvent.click(screen.getByLabelText('Unpin Pulse'))
		expect(unpin).toHaveBeenCalledWith('pulse')
	})

	it('renders AgentPulse and NavUser in footer', () => {
		render(<AppSidebar />)
		expect(screen.getByText('AgentPulse')).toBeInTheDocument()
		expect(screen.getByText('NavUser')).toBeInTheDocument()
	})
})
