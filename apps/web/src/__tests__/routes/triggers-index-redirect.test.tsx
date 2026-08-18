import { describe, expect, it, vi } from 'vitest'

const redirectMock = vi.fn((opts: unknown) => opts)

vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => (options: Record<string, unknown>) => options,
	redirect: (opts: unknown) => redirectMock(opts),
}))

import { Route } from '@/routes/_authed/$workspaceId/triggers/index'

const route = Route as unknown as {
	beforeLoad: (ctx: { params: { workspaceId: string } }) => void
	component?: unknown
}

describe('/$workspaceId/triggers redirect', () => {
	it('redirects to the workspace Loops list', () => {
		expect(() => route.beforeLoad({ params: { workspaceId: 'ws-1' } })).toThrow()
		expect(redirectMock).toHaveBeenCalledWith({
			to: '/$workspaceId/loops',
			params: { workspaceId: 'ws-1' },
		})
	})

	it('renders no page of its own — Loops is the only triggers surface', () => {
		expect(route.component).toBeUndefined()
	})
})
