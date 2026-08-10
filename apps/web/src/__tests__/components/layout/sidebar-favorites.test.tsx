import { SidebarFavorites } from '@/components/layout/sidebar-favorites'
import type { FileListItem } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useWorkspaceMock = vi.fn()
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => useWorkspaceMock(),
}))

const useFiles = vi.fn()
vi.mock('@/hooks/use-files', () => ({
	useFiles: (workspaceId: string, params?: { ids?: string[] }) => useFiles(workspaceId, params),
}))

const trackNavItemClicked = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackNavItemClicked: (p: { item_key: string; source: string }) => trackNavItemClicked(p),
}))

const setOpenMobile = vi.fn()
vi.mock('@/components/ui/sidebar', () => ({
	SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	useSidebar: () => ({ setOpenMobile }),
}))

// Captures the route + resolved params SidebarNavItem passes to the router so
// the wiring test can assert the pin opens through the files-viewer route.
const linkCalls: { to?: string; params?: Record<string, string> }[] = []
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		to,
		params,
		...rest
	}: {
		children: React.ReactNode
		to?: string
		params?: Record<string, string>
	}) => {
		linkCalls.push({ to, params })
		return (
			<a href={to} {...rest}>
				{children}
			</a>
		)
	},
	useMatchRoute: () => () => false,
}))

function buildFile(overrides: Partial<FileListItem> = {}): FileListItem {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'dashboard.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 1024,
		storageKey: 'ws-1/dashboard.html',
		createdBy: 'actor-1',
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-01T00:00:00Z',
		...overrides,
	}
}

describe('SidebarFavorites', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		linkCalls.length = 0
	})

	it('renders nothing when no files are pinned', () => {
		useWorkspaceMock.mockReturnValue({ workspaceId: 'ws-1', workspace: { settings: {} } })
		useFiles.mockReturnValue({ data: undefined })

		render(<SidebarFavorites />)

		expect(screen.queryByText('Favorites')).not.toBeInTheDocument()
		expect(useFiles).toHaveBeenCalledWith('ws-1', { ids: [] })
	})

	it('resolves pinned ids against the live file list — a reference, never a copy', () => {
		useWorkspaceMock.mockReturnValue({
			workspaceId: 'ws-1',
			workspace: { settings: { pinned_files: ['file-1', 'file-2'] } },
		})
		useFiles.mockReturnValue({
			data: [
				buildFile({ id: 'file-1', name: 'dashboard.html' }),
				buildFile({ id: 'file-2', name: 'report.html' }),
			],
		})

		render(<SidebarFavorites />)

		expect(useFiles).toHaveBeenCalledWith('ws-1', { ids: ['file-1', 'file-2'] })
		// Rendered from the current file rows: a nightly regen (same id, new
		// bytes via the storageKey/url) flows straight through this render.
		expect(screen.getByText('dashboard.html')).toBeInTheDocument()
		expect(screen.getByText('report.html')).toBeInTheDocument()
	})

	it('sends each pin through the same files-viewer route as any other file', () => {
		useWorkspaceMock.mockReturnValue({
			workspaceId: 'ws-1',
			workspace: { settings: { pinned_files: ['file-1'] } },
		})
		useFiles.mockReturnValue({ data: [buildFile()] })

		render(<SidebarFavorites />)

		expect(linkCalls[0]).toEqual({
			to: '/$workspaceId/files/$fileId',
			params: { workspaceId: 'ws-1', fileId: 'file-1' },
		})
	})

	it('drops pinned ids that no longer resolve instead of dead-linking', () => {
		useWorkspaceMock.mockReturnValue({
			workspaceId: 'ws-1',
			workspace: { settings: { pinned_files: ['file-1', 'gone'] } },
		})
		useFiles.mockReturnValue({ data: [buildFile()] })

		render(<SidebarFavorites />)

		expect(screen.getByText('dashboard.html')).toBeInTheDocument()
		expect(screen.queryByText('gone')).not.toBeInTheDocument()
	})

	it('emits nav_item_clicked with the favorites source per pinned entry', () => {
		useWorkspaceMock.mockReturnValue({
			workspaceId: 'ws-1',
			workspace: { settings: { pinned_files: ['file-1'] } },
		})
		useFiles.mockReturnValue({ data: [buildFile()] })

		render(<SidebarFavorites />)
		fireEvent.click(screen.getByText('dashboard.html'))

		expect(trackNavItemClicked).toHaveBeenCalledWith({
			item_key: 'favorites:file-1',
			source: 'favorites',
		})
	})
})
