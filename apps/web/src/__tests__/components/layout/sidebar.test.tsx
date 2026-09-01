import { AppSidebar } from '@/components/layout/sidebar'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// AppSidebar is the `new-design` boundary for the app shell; these specs assert
// the v2 chrome, so drive the flag on.
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'new-design',
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: vi.fn(() => ['work']),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: vi.fn(() => ({ data: { items: [] } })),
}))

vi.mock('@/hooks/use-chat-unread', () => ({
	useChatUnreadCount: vi.fn(() => ({ count: 0, hasMore: false })),
}))

vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: vi.fn((ids: string[]) =>
		ids.includes('work') ? [{ label: 'Bets', value: 'bet' }] : [],
	),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
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
	SidebarTrigger: ({ title, className }: { title?: string; className?: string }) => (
		<button type="button" title={title} className={className}>
			Toggle
		</button>
	),
	useSidebar: () => ({ setOpenMobile }),
}))

vi.mock('@/components/layout/sidebar-activity', () => ({
	SidebarActivity: () => <div data-testid="sidebar-activity">SidebarActivity</div>,
}))

vi.mock('@/components/layout/nav-user', () => ({
	NavUser: () => <div data-testid="nav-user">NavUser</div>,
}))

vi.mock('@/components/layout/workspace-switcher', () => ({
	WorkspaceSwitcher: () => <div data-testid="workspace-switcher">WorkspaceSwitcher</div>,
}))

import { useChatUnreadCount } from '@/hooks/use-chat-unread'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUnread } from '@/hooks/use-subscriptions'

describe('AppSidebar', () => {
	it('renders the v2 core navigation items in mockup order', () => {
		render(<AppSidebar />)
		expect(screen.getByText('For you')).toBeInTheDocument()
		expect(screen.getByText('Chats')).toBeInTheDocument()
		expect(screen.getByText('Loops')).toBeInTheDocument()
		expect(screen.getByText('Objects')).toBeInTheDocument()
	})

	// v2 reaches Agents through the working-agents card and triggers through the
	// "Not tied to a loop" group on Loops — neither is a nav entry.
	it('does not render Agents, Triggers, Activity or Briefing nav entries', () => {
		render(<AppSidebar />)
		expect(screen.queryByText('Agents')).not.toBeInTheDocument()
		expect(screen.queryByText('Triggers')).not.toBeInTheDocument()
		expect(screen.queryByText('Activity')).not.toBeInTheDocument()
		expect(screen.queryByText('Briefing')).not.toBeInTheDocument()
	})

	it('renders Marketplace as a footer nav entry above SidebarActivity', () => {
		render(<AppSidebar />)
		const marketplace = screen.getByText('Marketplace')
		const sidebarActivity = screen.getByTestId('sidebar-activity')
		expect(marketplace).toBeInTheDocument()
		expect(
			marketplace.compareDocumentPosition(sidebarActivity) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
	})

	it('shows Objects nav item when object types are enabled', () => {
		render(<AppSidebar />)
		expect(screen.getByText('Objects')).toBeInTheDocument()
	})

	it('hides Objects when no object types enabled', () => {
		vi.mocked(useEnabledModules).mockReturnValue([])
		render(<AppSidebar />)
		expect(screen.queryByText('Objects')).not.toBeInTheDocument()
	})

	// The release note moved into the For You feed (`foryou/release-card.tsx`),
	// so the footer is the working-agents row and the profile only.
	it('renders SidebarActivity and NavUser in footer', () => {
		vi.mocked(useEnabledModules).mockReturnValue(['work'])
		render(<AppSidebar />)
		expect(screen.queryByTestId('sidebar-release-card')).not.toBeInTheDocument()
		expect(screen.getByText('SidebarActivity')).toBeInTheDocument()
		expect(screen.getByText('NavUser')).toBeInTheDocument()
	})

	it('does not render a release announcement card — v2 dropped it', () => {
		render(<AppSidebar />)
		expect(screen.queryByTestId('sidebar-release-card')).not.toBeInTheDocument()
	})

	it('renders WorkspaceSwitcher in the header', () => {
		render(<AppSidebar />)
		expect(screen.getByTestId('workspace-switcher')).toBeInTheDocument()
	})

	it('pairs the workspace switcher with a collapse control that hides on the rail', () => {
		render(<AppSidebar />)
		const collapse = screen.getByTitle('Collapse sidebar')
		expect(collapse).toBeInTheDocument()
		expect(collapse.className).toContain('group-data-[collapsible=icon]:hidden')
	})

	it('renders a Chats nav item linking to the full-screen chats surface', () => {
		vi.mocked(useEnabledModules).mockReturnValue(['work'])
		render(<AppSidebar />)
		expect(screen.getByText('Chats')).toBeInTheDocument()
	})

	it('shows a chat unread count next to Chats, capped with a + when the page overflows', () => {
		vi.mocked(useEnabledModules).mockReturnValue(['work'])
		vi.mocked(useChatUnreadCount).mockReturnValue({ count: 50, hasMore: true })
		render(<AppSidebar />)
		expect(screen.getByLabelText('50+ unread')).toBeInTheDocument()
	})

	it('shows an unread count next to For You when there are unread threads', () => {
		vi.mocked(useChatUnreadCount).mockReturnValue({ count: 0, hasMore: false })
		vi.mocked(useUnread).mockReturnValue({
			data: {
				items: [
					{
						entity_type: 'object',
						entity_id: 'a',
						unread_count: 1,
						latest_event_id: 1,
						latest_activity_at: null,
					},
					{
						entity_type: 'object',
						entity_id: 'b',
						unread_count: 2,
						latest_event_id: 2,
						latest_activity_at: null,
					},
					{
						entity_type: 'object',
						entity_id: 'c',
						unread_count: 1,
						latest_event_id: 3,
						latest_activity_at: null,
					},
				],
			},
		} as unknown as ReturnType<typeof useUnread>)
		render(<AppSidebar />)
		expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
	})

	it('hides the unread badge when there are no unread threads', () => {
		vi.mocked(useUnread).mockReturnValue({
			data: { items: [] },
		} as unknown as ReturnType<typeof useUnread>)
		render(<AppSidebar />)
		expect(screen.queryByLabelText(/unread$/)).not.toBeInTheDocument()
	})
})
