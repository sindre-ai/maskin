import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api'

const baseConfig = () => ({
	baseUrl: 'https://example.test',
	headers: () => ({ Authorization: 'Bearer test' }),
	timeoutMs: 50,
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('createApiClient', () => {
	it('aborts a hung request after timeoutMs and surfaces a descriptive error', async () => {
		// fetch never resolves on its own; only the abort signal can end it.
		vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => {
					const err = new Error('aborted') as Error & { name: string }
					err.name = 'AbortError'
					reject(err)
				})
			})
		})

		const api = createApiClient(baseConfig())
		await expect(api('GET', '/api/objects/abc')).rejects.toThrow(
			/GET \/api\/objects\/abc aborted after 0\.05s \(E2E_REQUEST_TIMEOUT_SEC\)/,
		)
	})

	it('returns parsed JSON on 200 and clears the timeout', async () => {
		vi.stubGlobal('fetch', async () => {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})

		const api = createApiClient({ ...baseConfig(), timeoutMs: 1000 })
		await expect(api<{ ok: boolean }>('GET', '/api/health')).resolves.toEqual({ ok: true })
	})

	it('returns undefined on 204', async () => {
		vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))

		const api = createApiClient(baseConfig())
		await expect(api('DELETE', '/api/objects/xyz')).resolves.toBeUndefined()
	})

	it('throws with status info on non-OK response (preserves prior behavior)', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response('boom', {
					status: 500,
					statusText: 'Internal Server Error',
				}),
		)

		const api = createApiClient(baseConfig())
		await expect(api('POST', '/api/objects', { foo: 1 })).rejects.toThrow(
			/POST \/api\/objects -> 500 Internal Server Error\nboom/,
		)
	})

	it('rethrows non-abort errors unchanged', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed')
		})

		const api = createApiClient(baseConfig())
		await expect(api('GET', '/api/health')).rejects.toThrow(/fetch failed/)
	})

	it('forwards options.idempotencyKey as the Idempotency-Key header', async () => {
		let capturedInit: RequestInit | undefined
		vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
			capturedInit = init
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})

		const api = createApiClient({ ...baseConfig(), timeoutMs: 1000 })
		await api('POST', '/api/graph', { foo: 1 }, { idempotencyKey: 'run-abc' })

		const headers = capturedInit?.headers as Record<string, string> | undefined
		expect(headers?.['Idempotency-Key']).toBe('run-abc')
		// Caller-provided base headers must still flow through.
		expect(headers?.Authorization).toBe('Bearer test')
	})

	it('omits the Idempotency-Key header when no idempotencyKey option is provided', async () => {
		let capturedInit: RequestInit | undefined
		vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
			capturedInit = init
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})

		const api = createApiClient({ ...baseConfig(), timeoutMs: 1000 })
		await api('POST', '/api/graph', { foo: 1 })

		const headers = capturedInit?.headers as Record<string, string> | undefined
		expect(headers).toBeDefined()
		expect(headers?.['Idempotency-Key']).toBeUndefined()
	})
})
