import { AppSidebar } from '@/components/layout/sidebar'
import { useBillingUsage } from '@/hooks/use-billing'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: vi.fn(() => ['work']),
}))

vi.mock('@/hooks/use-for-you', () => ({
	useForYou: vi.fn(() => ({ data: { items: [] } })),
}))

vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: vi.fn(() => ({ data: undefined })),
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
import { useForYou } from '@/hooks/use-for-you'

describe('AppSidebar', () => {
	it('renders the v2 core navigation items in mockup order', () => {
		render(<AppSidebar />)
		expect(screen.getByText('For you')).toBeInTheDocument()
		expect(screen.getByText('Chats')).toBeInTheDocument()
		expect(screen.getByText('Flows')).toBeInTheDocument()
		expect(screen.getByText('Items')).toBeInTheDocument()
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

	it('shows Items nav item when object types are enabled', () => {
		render(<AppSidebar />)
		expect(screen.getByText('Items')).toBeInTheDocument()
	})

	it('hides Items when no object types enabled', () => {
		vi.mocked(useEnabledModules).mockReturnValue([])
		render(<AppSidebar />)
		expect(screen.queryByText('Items')).not.toBeInTheDocument()
	})

	// The release note is gone from the sidebar (and from For You),
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

	it('shows a count next to For You for each item on the curated list', () => {
		vi.mocked(useChatUnreadCount).mockReturnValue({ count: 0, hasMore: false })
		vi.mocked(useForYou).mockReturnValue({
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
		} as unknown as ReturnType<typeof useForYou>)
		render(<AppSidebar />)
		expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
	})

	it('hides the badge when the curated list is empty', () => {
		vi.mocked(useForYou).mockReturnValue({
			data: { items: [] },
		} as unknown as ReturnType<typeof useForYou>)
		render(<AppSidebar />)
		expect(screen.queryByLabelText(/unread$/)).not.toBeInTheDocument()
	})

	describe('trial card', () => {
		const DAY = 24 * 60 * 60 * 1000
		const usage = (plan: string, ms: number | null) =>
			({ data: { plan, period_resets_in_ms: ms } }) as unknown as ReturnType<typeof useBillingUsage>

		it('shows the days left and an Upgrade link above Marketplace on a trial', () => {
			vi.mocked(useBillingUsage).mockReturnValue(usage('trial', 4.2 * DAY))
			render(<AppSidebar />)
			const title = screen.getByText('Trial ends in 5 days')
			expect(screen.getByText('Choose a plan to keep your agents running.')).toBeInTheDocument()
			expect(screen.getByRole('link', { name: 'Upgrade' })).toBeInTheDocument()
			expect(
				title.compareDocumentPosition(screen.getByText('Marketplace')) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy()
		})

		it('is hidden on a paid plan', () => {
			vi.mocked(useBillingUsage).mockReturnValue(usage('pro', 20 * DAY))
			render(<AppSidebar />)
			expect(screen.queryByText(/Trial ends/)).not.toBeInTheDocument()
		})

		it('is hidden once the trial has ended', () => {
			vi.mocked(useBillingUsage).mockReturnValue(usage('trial', 0))
			render(<AppSidebar />)
			expect(screen.queryByText(/Trial ends/)).not.toBeInTheDocument()
		})
	})
})
