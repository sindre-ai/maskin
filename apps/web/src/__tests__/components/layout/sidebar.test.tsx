import { AppSidebar } from '@/components/layout/sidebar'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: vi.fn(() => ['work']),
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

vi.mock('@/components/ui/sidebar', () => ({
	Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarRail: () => <div />,
	SidebarTrigger: () => <button type="button">Toggle</button>,
	useSidebar: () => ({ setOpenMobile: vi.fn() }),
}))

vi.mock('@/components/agents/agent-pulse', () => ({
	AgentPulse: () => <div data-testid="agent-pulse">AgentPulse</div>,
}))

vi.mock('@/components/layout/nav-user', () => ({
	NavUser: () => <div data-testid="nav-user">NavUser</div>,
}))

import { useEnabledModules } from '@/hooks/use-enabled-modules'

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
})
