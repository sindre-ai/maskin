import { AppSidebar } from '@/components/layout/sidebar'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: vi.fn(() => ['work']),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: vi.fn(() => ({ data: { items: [] } })),
}))

vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: vi.fn((ids: string[]) =>
		ids.includes('work') ? [{ label: 'Bets', value: 'bet' }] : [],
	),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const setChatOpen = vi.fn()
vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ setOpen: setChatOpen }),
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
	SidebarTrigger: () => <button type="button">Toggle</button>,
	useSidebar: () => ({ setOpenMobile }),
}))

vi.mock('@/components/agents/agent-pulse', () => ({
	AgentPulse: () => <div data-testid="agent-pulse">AgentPulse</div>,
}))

vi.mock('@/components/layout/nav-user', () => ({
	NavUser: () => <div data-testid="nav-user">NavUser</div>,
}))

vi.mock('@/components/layout/workspace-switcher', () => ({
	WorkspaceSwitcher: () => <div data-testid="workspace-switcher">WorkspaceSwitcher</div>,
}))

import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUnread } from '@/hooks/use-subscriptions'

describe('AppSidebar', () => {
	it('renders core navigation items', () => {
		render(<AppSidebar />)
		expect(screen.getByText('For You')).toBeInTheDocument()
		expect(screen.getByText('Activity')).toBeInTheDocument()
		expect(screen.getByText('Agents')).toBeInTheDocument()
		expect(screen.getByText('Triggers')).toBeInTheDocument()
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

	it('renders AgentPulse and NavUser in footer', () => {
		vi.mocked(useEnabledModules).mockReturnValue(['work'])
		render(<AppSidebar />)
		expect(screen.getByText('AgentPulse')).toBeInTheDocument()
		expect(screen.getByText('NavUser')).toBeInTheDocument()
	})

	it('renders the WorkspaceSwitcher in the sidebar header', () => {
		render(<AppSidebar />)
		expect(screen.getByText('WorkspaceSwitcher')).toBeInTheDocument()
	})

	it('does not render a chat launcher — lives in the app header now', () => {
		vi.mocked(useEnabledModules).mockReturnValue(['work'])
		render(<AppSidebar />)
		expect(screen.queryByText('Chat')).not.toBeInTheDocument()
	})

	it('shows an unread count next to For You when there are unread threads', () => {
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
