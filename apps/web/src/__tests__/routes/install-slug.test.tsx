import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
const mockMutate = vi.fn()
let mockSlug = 'market-competitor-watch-loop'
let mockAuthed = true

const LOOP = {
	id: 'loop-1',
	name: 'Competitor watch',
	slug: 'market-competitor-watch-loop',
	description: 'Watch what your competitors ship.',
}
let mockLoops = [LOOP]
let mockWorkspaces = [{ id: 'ws-1', name: 'Nordic Labs' }]
let mockInstalls: Array<{ sourceLoopId: string; objectId: string | null }> = []

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		redirect: (opts: unknown) => ({ redirectOptions: opts }),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useParams: () => ({ slug: mockSlug }),
		}),
	}
})

vi.mock('@/lib/auth', () => ({ isAuthenticated: () => mockAuthed }))
vi.mock('@/lib/last-workspace', () => ({ getLastWorkspaceId: () => null }))
vi.mock('@/hooks/use-marketplace-loops', () => ({
	useMarketplaceLoops: () => ({ data: { loops: mockLoops }, isLoading: false, isError: false }),
	useMarketplaceLoop: () => ({
		data: {
			loop: LOOP,
			items: [{ item_type: 'actor' }, { item_type: 'actor' }, { item_type: 'trigger' }],
		},
	}),
}))
vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaces: () => ({ data: mockWorkspaces, isLoading: false }),
}))
vi.mock('@/hooks/use-installed-loops', () => ({
	useInstalledLoops: () => ({ data: { installs: mockInstalls } }),
	useInstallLoop: () => ({ mutate: mockMutate, isPending: false, error: null }),
}))

import { Route } from '@/routes/install.$slug'

const route = Route as unknown as {
	component: React.FC
	beforeLoad: (ctx: { location: { href: string } }) => void
}

describe('install page', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSlug = 'market-competitor-watch-loop'
		mockAuthed = true
		mockLoops = [LOOP]
		mockWorkspaces = [{ id: 'ws-1', name: 'Nordic Labs' }]
		mockInstalls = []
	})

	it('sends a signed-out visitor to sign-in and back to this page', () => {
		mockAuthed = false
		let thrown: unknown
		try {
			route.beforeLoad({ location: { href: '/install/market-competitor-watch-loop' } })
		} catch (err) {
			thrown = err
		}
		expect(thrown).toEqual({
			redirectOptions: {
				to: '/login',
				search: { redirect: '/install/market-competitor-watch-loop' },
			},
		})
	})

	it('shows the loop, what comes with it and the workspace', () => {
		render(<route.component />)
		expect(screen.getByText('Competitor watch')).toBeInTheDocument()
		expect(screen.getByText('Watch what your competitors ship.')).toBeInTheDocument()
		expect(screen.getByText('Comes with 2 agents, 1 trigger.')).toBeInTheDocument()
		expect(screen.getByText('Nordic Labs')).toBeInTheDocument()
	})

	it('installs once with the public_site source and opens the loop in Manage', async () => {
		mockMutate.mockImplementation((_vars, opts) => opts.onSuccess({ objectId: 'obj-9' }))
		render(<route.component />)
		await userEvent.setup().click(screen.getByRole('button', { name: 'Install' }))

		expect(mockMutate).toHaveBeenCalledTimes(1)
		expect(mockMutate.mock.calls[0][0]).toEqual({ loopId: 'loop-1', source: 'public_site' })
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/loops/$loopId',
			params: { workspaceId: 'ws-1', loopId: 'obj-9' },
		})
	})

	it('says Already installed and offers Manage instead of installing twice', async () => {
		mockInstalls = [{ sourceLoopId: 'loop-1', objectId: 'obj-3' }]
		render(<route.component />)

		expect(screen.getByText('Already installed')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
		await userEvent.setup().click(screen.getByRole('button', { name: 'Manage' }))
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/loops/$loopId',
			params: { workspaceId: 'ws-1', loopId: 'obj-3' },
		})
		expect(mockMutate).not.toHaveBeenCalled()
	})

	it('shows a plain not-found message with a link to the public marketplace for an unknown slug', () => {
		mockSlug = 'no-such-loop'
		render(<route.component />)

		expect(screen.getByText("We couldn't find that loop")).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'See all loops' })).toHaveAttribute(
			'href',
			'https://maskin.io/marketplace/',
		)
		expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
	})
})
