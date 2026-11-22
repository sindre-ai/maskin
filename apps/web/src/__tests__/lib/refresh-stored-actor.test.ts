import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { actors: { get: vi.fn() } } }))

// The refresh is remembered per page load, so every test starts from a fresh copy of the module.
// The mocked api survives a module reset, so its calls and answers are cleared here too.
async function load() {
	vi.resetModules()
	const refresh = await import('@/lib/refresh-stored-actor')
	const { api } = await import('@/lib/api')
	const auth = await import('@/lib/auth')
	const get = vi.mocked(api.actors.get)
	get.mockReset()
	return { ...refresh, ...auth, get }
}

const stale = { id: 'actor-1', name: 'Sebk', type: 'human', email: 'seb@example.com' }

beforeEach(() => {
	localStorage.clear()
})

describe('refreshStoredActor', () => {
	it('replaces a stale saved name with the live one and keeps the rest', async () => {
		const { refreshStoredActor, setStoredActor, getStoredActor, get } = await load()
		setStoredActor(stale)
		get.mockResolvedValue({ id: 'actor-1', name: 'Sebastian Krumhausen' } as never)

		await refreshStoredActor()

		expect(get).toHaveBeenCalledWith('actor-1')
		expect(getStoredActor()).toEqual({ ...stale, name: 'Sebastian Krumhausen' })
	})

	it('does nothing when nobody is signed in', async () => {
		const { refreshStoredActor, getStoredActor, get } = await load()

		await refreshStoredActor()

		expect(get).not.toHaveBeenCalled()
		expect(getStoredActor()).toBeNull()
	})

	it('reads the live record once per page load', async () => {
		const { refreshStoredActor, setStoredActor, get } = await load()
		setStoredActor(stale)
		get.mockResolvedValue({ id: 'actor-1', name: 'Sebastian Krumhausen' } as never)

		await refreshStoredActor()
		await refreshStoredActor()

		expect(get).toHaveBeenCalledTimes(1)
	})

	it('keeps the saved name when the read fails, and tries again next time', async () => {
		const { refreshStoredActor, setStoredActor, getStoredActor, get } = await load()
		setStoredActor(stale)
		get.mockRejectedValueOnce(new Error('offline'))

		await expect(refreshStoredActor()).resolves.toBeUndefined()
		expect(getStoredActor()?.name).toBe('Sebk')

		get.mockResolvedValue({ id: 'actor-1', name: 'Sebastian Krumhausen' } as never)
		await refreshStoredActor()
		expect(getStoredActor()?.name).toBe('Sebastian Krumhausen')
	})
})

describe('syncStoredActor', () => {
	it('ignores a record for someone else', async () => {
		const { syncStoredActor, setStoredActor, getStoredActor } = await load()
		setStoredActor(stale)

		syncStoredActor({ id: 'actor-2', name: 'Someone Else' })

		expect(getStoredActor()?.name).toBe('Sebk')
	})
})
