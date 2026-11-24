import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ getApiKey: vi.fn(() => 'ank_test') }))

/**
 * VITE_API_ORIGIN points API calls at a second host that skips the Cloudflare Worker. Sign-in is
 * a bearer key, so it follows the call. The OAuth connect call is the exception: it depends on a
 * host-only cookie and a callback that lands on the page's host, so it must stay on the page's host.
 */
async function load(origin: string | undefined) {
	vi.resetModules()
	if (origin === undefined) vi.stubEnv('VITE_API_ORIGIN', '')
	else vi.stubEnv('VITE_API_ORIGIN', origin)
	const constants = await import('@/lib/constants')
	const { api } = await import('@/lib/api')
	return { ...constants, api }
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe('API_ORIGIN', () => {
	it('is empty and keeps calls on the page host when unset', async () => {
		const { API_ORIGIN, API_BASE } = await load(undefined)
		expect(API_ORIGIN).toBe('')
		expect(API_BASE).toBe('/api')
	})

	it('prefixes API_BASE and drops a trailing slash', async () => {
		const { API_ORIGIN, API_BASE } = await load('https://api.example.test/')
		expect(API_ORIGIN).toBe('https://api.example.test')
		expect(API_BASE).toBe('https://api.example.test/api')
	})
})

describe('request routing with an API origin', () => {
	const ok = () => new Response(JSON.stringify({}), { status: 200 })

	it('sends an ordinary call to the API origin with the bearer key', async () => {
		const { api } = await load('https://api.example.test')
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
		await api.integrations.connect('ws-1', 'github').catch(() => {})
		await api.actors.get('a-1', 'ws-1').catch(() => {})
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
		expect(urls).toContain('https://api.example.test/api/actors/a-1')
	})

	it('keeps the OAuth connect call on the page host so its cookie and callback match', async () => {
		const { api } = await load('https://api.example.test')
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
		await api.integrations.connect('ws-1', 'github').catch(() => {})
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/integrations/github/connect')
		expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' })
	})
})
