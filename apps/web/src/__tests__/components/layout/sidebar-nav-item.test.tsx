import { SidebarNavItem } from '@/components/layout/sidebar-nav-item'
import { fireEvent, render, screen } from '@testing-library/react'
import { Zap } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

const trackNavItemClicked = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackNavItemClicked: (p: { item_key: string; source: string }) => trackNavItemClicked(p),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const setOpenMobile = vi.fn()
vi.mock('@/components/ui/sidebar', () => ({
	SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({
		children,
		tooltip,
	}: { children: React.ReactNode; tooltip?: string; asChild?: boolean; isActive?: boolean }) => (
		<div data-tooltip={tooltip}>{children}</div>
	),
	useSidebar: () => ({ setOpenMobile }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		useMatchRoute: () => () => false,
	}
})

describe('SidebarNavItem', () => {
	it('emits nav_item_clicked with the stable item_key and top-nav source when clicked', () => {
		render(
			<SidebarNavItem
				item={{
					key: 'marketplace',
					label: 'Marketplace',
					to: '/$workspaceId/marketplace',
					icon: Zap,
				}}
				source="top-nav"
			/>,
		)

		fireEvent.click(screen.getByText('Marketplace'))

		expect(trackNavItemClicked).toHaveBeenCalledWith({
			item_key: 'marketplace',
			source: 'top-nav',
		})
	})

	it('flips the source to footer when the caller renders it in the footer slot', () => {
		trackNavItemClicked.mockClear()
		render(
			<SidebarNavItem
				item={{
					key: 'marketplace',
					label: 'Marketplace',
					to: '/$workspaceId/marketplace',
					icon: Zap,
				}}
				source="footer"
			/>,
		)

		fireEvent.click(screen.getByText('Marketplace'))

		expect(trackNavItemClicked).toHaveBeenCalledWith({
			item_key: 'marketplace',
			source: 'footer',
		})
	})

	it('also collapses the mobile sidebar on click, matching the prior inline handler behaviour', () => {
		trackNavItemClicked.mockClear()
		setOpenMobile.mockClear()
		render(
			<SidebarNavItem
				item={{
					key: 'for-you',
					label: 'For You',
					to: '/$workspaceId',
					icon: Zap,
					exact: true,
				}}
				source="top-nav"
			/>,
		)

		fireEvent.click(screen.getByText('For You'))

		expect(setOpenMobile).toHaveBeenCalledWith(false)
	})
})
