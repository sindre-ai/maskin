import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		redirect: (opts: Record<string, unknown>) => ({ redirect: opts }),
	}
})

import { Route as WorkspacesRoute } from '@/routes/_authed/workspaces'

const beforeLoad = (WorkspacesRoute as unknown as { beforeLoad: () => void }).beforeLoad

describe('_authed /workspaces redirect', () => {
	it('redirects to the index route so the last-viewed workspace is opened', () => {
		expect(beforeLoad).toThrow(expect.objectContaining({ redirect: { to: '/', replace: true } }))
	})
})
