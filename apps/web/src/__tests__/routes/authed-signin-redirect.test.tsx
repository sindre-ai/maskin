import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthenticated = vi.fn()
const mockRefreshStoredActor = vi.fn()

vi.mock('@/lib/auth', () => ({
	isAuthenticated: () => mockIsAuthenticated(),
}))

vi.mock('@/lib/refresh-stored-actor', () => ({
	refreshStoredActor: () => mockRefreshStoredActor(),
}))

vi.mock('@/lib/feature-flags', () => ({
	hasCachedFlags: () => true,
	loadFeatureFlags: vi.fn(),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		redirect: (opts: Record<string, unknown>) => ({ redirect: opts }),
	}
})

import { Route } from '@/routes/_authed'

const beforeLoad = (
	Route as unknown as { beforeLoad: (ctx: { location: { href: string } }) => Promise<void> }
).beforeLoad

describe('_authed sign-in redirect', () => {
	beforeEach(() => {
		mockIsAuthenticated.mockReturnValue(false)
		mockRefreshStoredActor.mockReset()
		mockRefreshStoredActor.mockResolvedValue(undefined)
	})

	it('sends a signed-out visitor to login with the page they wanted, query string and all', async () => {
		await expect(
			beforeLoad({ location: { href: '/ws-1/objects/abc?tab=comments' } }),
		).rejects.toEqual({
			redirect: { to: '/login', search: { redirect: '/ws-1/objects/abc?tab=comments' } },
		})
	})

	it('sends them to plain login when they only asked for the front page', async () => {
		await expect(beforeLoad({ location: { href: '/' } })).rejects.toEqual({
			redirect: { to: '/login', search: {} },
		})
	})

	it('does not pass on a target that is not a path inside the app', async () => {
		await expect(beforeLoad({ location: { href: '//evil.example' } })).rejects.toEqual({
			redirect: { to: '/login', search: {} },
		})
	})

	it('does not look up the saved name for a signed-out visitor', async () => {
		await expect(beforeLoad({ location: { href: '/' } })).rejects.toBeDefined()
		expect(mockRefreshStoredActor).not.toHaveBeenCalled()
	})

	it('lets a signed-in person through', async () => {
		mockIsAuthenticated.mockReturnValue(true)
		await expect(beforeLoad({ location: { href: '/ws-1' } })).resolves.toBeUndefined()
	})

	it('refreshes the saved name before a signed-in person gets through', async () => {
		mockIsAuthenticated.mockReturnValue(true)
		let finish: () => void = () => {}
		mockRefreshStoredActor.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve
			}),
		)
		let done = false
		const pending = beforeLoad({ location: { href: '/ws-1' } }).then(() => {
			done = true
		})

		await Promise.resolve()
		expect(mockRefreshStoredActor).toHaveBeenCalledTimes(1)
		expect(done).toBe(false)

		finish()
		await pending
		expect(done).toBe(true)
	})
})
