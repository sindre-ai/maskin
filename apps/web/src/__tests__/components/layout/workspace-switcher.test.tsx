import { WorkspaceSwitcher } from '@/components/layout/workspace-switcher'
import type { WorkspaceWithRole } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'

const mockNavigate = vi.fn()
const setOpenMobile = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@/components/ui/sidebar', () => ({
	SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	SidebarMenuButton: ({
		children,
		tooltip,
		...rest
	}: { children: ReactNode; tooltip?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button type="button" data-tooltip={tooltip} {...rest}>
			{children}
		</button>
	),
	useSidebar: () => ({ isMobile: false, setOpenMobile }),
}))

const wsA = buildWorkspaceWithRole({ id: 'ws-a', name: 'Workspace Alpha' })
const wsB = buildWorkspaceWithRole({ id: 'ws-b', name: 'Workspace Beta' })

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: wsA, workspaceId: 'ws-a' }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaces: vi.fn(),
}))

const trackOpened = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackSidebarWorkspaceSwitcherOpened: (p: { workspaceId: string }) => trackOpened(p),
}))

import { useWorkspaces } from '@/hooks/use-workspaces'

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	return {
		client,
		Wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	}
}

function mockHook(value: Partial<ReturnType<typeof useWorkspaces>>) {
	vi.mocked(useWorkspaces).mockReturnValue(value as ReturnType<typeof useWorkspaces>)
}

describe('WorkspaceSwitcher', () => {
	beforeEach(() => {
		mockNavigate.mockReset()
		setOpenMobile.mockReset()
		trackOpened.mockReset()
	})

	it('shows the current workspace name on the pill (AC-U1)', () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { Wrapper } = makeWrapper()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })
		expect(screen.getByText('Workspace Alpha')).toBeInTheDocument()
	})

	it('lists every workspace with the current one marked when opened (AC-U2)', async () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { Wrapper } = makeWrapper()
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })

		await user.click(screen.getByRole('button', { name: /Switch workspace/ }))

		const items = await screen.findAllByRole('menuitem')
		expect(items.map((i) => i.textContent)).toEqual(
			expect.arrayContaining(['Workspace Alpha', 'Workspace Beta']),
		)
		const alphaItem = items.find((i) => i.textContent === 'Workspace Alpha')
		expect(alphaItem?.querySelector('svg')).toBeTruthy()
	})

	it('navigates to the selected workspace and drops workspace-scoped caches (AC-U3, AC-T4)', async () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { client, Wrapper } = makeWrapper()

		client.setQueryData(queryKeys.objects.all('ws-a'), [{ id: 'obj-1' }])
		client.setQueryData(queryKeys.sessions.all('ws-a'), [{ id: 'session-1' }])
		client.setQueryData(queryKeys.subscriptions.unread('ws-a'), {
			items: [{ entity_id: 'a' }],
		})
		client.setQueryData(queryKeys.installedLoops.all('ws-a'), [{ id: 'loop-1' }])
		client.setQueryData(queryKeys.events.history('ws-a'), [{ id: 'event-1' }])

		const user = userEvent.setup()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })

		await user.click(screen.getByRole('button', { name: /Switch workspace/ }))
		await user.click(screen.getByRole('menuitem', { name: 'Workspace Beta' }))

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId',
			params: { workspaceId: 'ws-b' },
		})
		expect(client.getQueryData(queryKeys.objects.all('ws-a'))).toBeUndefined()
		expect(client.getQueryData(queryKeys.sessions.all('ws-a'))).toBeUndefined()
		expect(client.getQueryData(queryKeys.subscriptions.unread('ws-a'))).toBeUndefined()
		expect(client.getQueryData(queryKeys.installedLoops.all('ws-a'))).toBeUndefined()
		expect(client.getQueryData(queryKeys.events.history('ws-a'))).toBeUndefined()
	})

	it('does not navigate when the current workspace is reselected', async () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { Wrapper } = makeWrapper()
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })

		await user.click(screen.getByRole('button', { name: /Switch workspace/ }))
		await user.click(screen.getByRole('menuitem', { name: 'Workspace Alpha' }))

		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('shows a skeleton on the pill while workspaces are loading (AC-T2)', () => {
		mockHook({ data: undefined, isLoading: true, isError: false })
		const { Wrapper } = makeWrapper()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })
		expect(screen.getByTestId('workspace-pill-skeleton')).toBeInTheDocument()
	})

	it('falls back to the URL workspaceId on error (AC-T2)', () => {
		mockHook({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error('fetch failed'),
		})
		const { Wrapper } = makeWrapper()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })
		// Brief: on error the pill falls back to the URL workspaceId so it still
		// renders something legible without collapsing or shifting the shell.
		expect(screen.getByText('ws-a')).toBeInTheDocument()
		expect(screen.queryByTestId('workspace-pill-skeleton')).not.toBeInTheDocument()
	})

	it('shows a retry option in the dropdown when workspaces fail to load (AC-T2)', async () => {
		const refetch = vi.fn()
		mockHook({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error('fetch failed'),
			refetch,
		})
		const { Wrapper } = makeWrapper()
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })

		await user.click(screen.getByRole('button', { name: /Switch workspace/ }))

		const retryItem = await screen.findByText(/Couldn't load workspaces/)
		expect(retryItem).toBeInTheDocument()

		await user.click(retryItem)
		expect(refetch).toHaveBeenCalledTimes(1)
	})

	it('sets aria-label and tooltip to the current workspace name (AC-T3)', () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { Wrapper } = makeWrapper()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })
		const trigger = screen.getByRole('button', { name: /Switch workspace/ })
		expect(trigger.getAttribute('aria-label')).toContain('Workspace Alpha')
		expect(trigger.getAttribute('data-tooltip')).toBe('Workspace Alpha')
	})

	it('emits sidebar.workspace_switcher.opened when the dropdown opens (T4)', async () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { Wrapper } = makeWrapper()
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })

		await user.click(screen.getByRole('button', { name: /Switch workspace/ }))

		expect(trackOpened).toHaveBeenCalledTimes(1)
		expect(trackOpened).toHaveBeenCalledWith({ workspaceId: 'ws-a' })
	})

	it('does not emit sidebar.workspace_switcher.opened when the dropdown closes', async () => {
		mockHook({ data: [wsA, wsB], isLoading: false, isError: false })
		const { Wrapper } = makeWrapper()
		const user = userEvent.setup()
		render(<WorkspaceSwitcher />, { wrapper: Wrapper })

		const trigger = screen.getByRole('button', { name: /Switch workspace/ })
		await user.click(trigger)
		expect(trackOpened).toHaveBeenCalledTimes(1)
		await user.keyboard('{Escape}')
		expect(trackOpened).toHaveBeenCalledTimes(1)
	})

	function _typeCheck(): WorkspaceWithRole {
		return wsA
	}
})
