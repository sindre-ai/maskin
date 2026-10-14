import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
	getApiKey: vi.fn(),
}))

import { ApiError, api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'

// biome-ignore lint/suspicious/noExplicitAny: test spy type
let fetchSpy: any

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(getApiKey).mockReturnValue(null)
	fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
	fetchSpy.mockRestore()
})

describe('ApiError', () => {
	it('sets status, message, and fieldErrors', () => {
		const err = new ApiError(400, 'Bad request', { name: ['required'] })
		expect(err.status).toBe(400)
		expect(err.message).toBe('Bad request')
		expect(err.fieldErrors).toEqual({ name: ['required'] })
		expect(err.name).toBe('ApiError')
	})

	it('defaults fieldErrors to empty object', () => {
		const err = new ApiError(500, 'Server error')
		expect(err.fieldErrors).toEqual({})
	})

	it('hasFieldErrors returns true when fieldErrors has entries', () => {
		const err = new ApiError(400, 'Bad', { field: ['err'] })
		expect(err.hasFieldErrors()).toBe(true)
	})

	it('hasFieldErrors returns false when fieldErrors is empty', () => {
		const err = new ApiError(400, 'Bad')
		expect(err.hasFieldErrors()).toBe(false)
	})
})

describe('request', () => {
	it('sends Authorization header when API key exists', async () => {
		vi.mocked(getApiKey).mockReturnValue('ank_test123')
		fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

		await api.objects.list('ws-1')

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/objects',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer ank_test123',
					'X-Workspace-Id': 'ws-1',
				}),
			}),
		)
	})

	it('does not send Authorization header when no API key', async () => {
		vi.mocked(getApiKey).mockReturnValue(null)
		fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

		await api.objects.list('ws-1')

		const headers = (fetchSpy.mock.calls[0][1] as RequestInit)?.headers as Record<string, string>
		expect(headers.Authorization).toBeUndefined()
	})

	it('sends X-Workspace-Id header when workspaceId provided', async () => {
		fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

		await api.objects.list('ws-42')

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/objects',
			expect.objectContaining({
				headers: expect.objectContaining({
					'X-Workspace-Id': 'ws-42',
				}),
			}),
		)
	})

	// Backend routes attribute knowledge_object_created/_read `created_via` /
	// `accessed_via` from this header — the web client must self-declare
	// alongside MCP callers so the fallback (actorType inference) never has
	// to decide between two human-actor paths.
	it('sends X-Client-Source: ui on every request', async () => {
		fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

		await api.objects.list('ws-1')

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/objects',
			expect.objectContaining({
				headers: expect.objectContaining({
					'X-Client-Source': 'ui',
				}),
			}),
		)
	})

	it('sends Content-Type and body for POST requests', async () => {
		vi.mocked(getApiKey).mockReturnValue('ank_key')
		fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: '1' }), { status: 200 }))

		await api.objects.create('ws-1', {
			type: 'bet',
			title: 'New bet',
			status: 'active',
		})

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/objects',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'Content-Type': 'application/json',
				}),
				body: JSON.stringify({ type: 'bet', title: 'New bet', status: 'active' }),
			}),
		)
	})

	it('throws ApiError with structured error format', async () => {
		const errorBody = {
			error: {
				code: 'BAD_REQUEST',
				message: 'Validation failed',
				details: [
					{ field: 'title', message: 'Required' },
					{ field: 'status', message: 'Invalid status' },
				],
			},
		}
		fetchSpy.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 400 }))

		try {
			await api.objects.list('ws-1')
			expect.unreachable('Should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError)
			const apiErr = err as ApiError
			expect(apiErr.status).toBe(400)
			expect(apiErr.message).toBe('Validation failed')
			expect(apiErr.fieldErrors).toEqual({
				title: ['Required'],
				status: ['Invalid status'],
			})
		}
	})

	it('throws ApiError with the flat { code, message, retryAfterMs } format', async () => {
		const errorBody = {
			code: 'RATE_LIMITED',
			message: 'Too many rounds sent.',
			retryAfterMs: 12_000,
		}
		fetchSpy.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 429 }))

		try {
			await api.objects.list('ws-1')
			expect.unreachable('Should have thrown')
		} catch (err) {
			const apiErr = err as ApiError
			expect(apiErr.status).toBe(429)
			expect(apiErr.code).toBe('RATE_LIMITED')
			expect(apiErr.message).toBe('Too many rounds sent.')
			expect(apiErr.retryAfterMs).toBe(12_000)
		}
	})

	it('throws ApiError with legacy string error format', async () => {
		const errorBody = { error: 'Not found' }
		fetchSpy.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 404 }))

		try {
			await api.objects.list('ws-1')
			expect.unreachable('Should have thrown')
		} catch (err) {
			const apiErr = err as ApiError
			expect(apiErr.status).toBe(404)
			expect(apiErr.message).toBe('Not found')
		}
	})

	it('throws ApiError with statusText fallback on JSON parse failure', async () => {
		fetchSpy.mockResolvedValue(
			new Response('not json', { status: 500, statusText: 'Internal Server Error' }),
		)

		try {
			await api.objects.list('ws-1')
			expect.unreachable('Should have thrown')
		} catch (err) {
			const apiErr = err as ApiError
			expect(apiErr.status).toBe(500)
			expect(apiErr.message).toBe('Internal Server Error')
		}
	})
})

describe('sessions.input', () => {
	it('POSTs content to /sessions/:id/input with workspace header', async () => {
		vi.mocked(getApiKey).mockReturnValue('ank_key')
		fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

		const result = await api.sessions.input('sess-1', { content: 'hello' }, 'ws-1')

		expect(result).toEqual({ ok: true })
		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/sessions/sess-1/input',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'Content-Type': 'application/json',
					'X-Workspace-Id': 'ws-1',
				}),
				body: JSON.stringify({ content: 'hello' }),
			}),
		)
	})

	it('includes attachments when provided', async () => {
		vi.mocked(getApiKey).mockReturnValue('ank_key')
		fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

		await api.sessions.input(
			'sess-1',
			{ content: 'review this', attachments: [{ kind: 'object', id: 'obj-1' }] },
			'ws-1',
		)

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/sessions/sess-1/input',
			expect.objectContaining({
				body: JSON.stringify({
					content: 'review this',
					attachments: [{ kind: 'object', id: 'obj-1' }],
				}),
			}),
		)
	})

	it('throws ApiError on 409 when session is not interactive or not running', async () => {
		const errorBody = { error: { code: 'CONFLICT', message: 'Session is not interactive' } }
		fetchSpy.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 409 }))

		await expect(api.sessions.input('sess-1', { content: 'hi' }, 'ws-1')).rejects.toMatchObject({
			status: 409,
			message: 'Session is not interactive',
		})
	})
})

describe('api.invites', () => {
	it('sends no X-Workspace-Id when accepting an invite, even while signed in', async () => {
		vi.mocked(getApiKey).mockReturnValue('ank_test123')
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ workspaceId: 'ws-1', actorId: 'a-1' }), { status: 200 }),
		)

		await api.invites.accept('tok/en+1')

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('/api/invites/tok%2Fen%2B1/accept')
		expect(init.method).toBe('POST')
		expect(init.body).toBe('{}')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer ank_test123')
		expect(headers['X-Workspace-Id']).toBeUndefined()
	})

	it('posts the signup body on accept for a new account', async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ workspaceId: 'ws-1' }), { status: 201 }),
		)

		await api.invites.accept('tok', { email: 'ada@example.com', password: 'hunter2hunter2' })

		const init = fetchSpy.mock.calls[0][1] as RequestInit
		expect(JSON.parse(init.body as string)).toEqual({
			email: 'ada@example.com',
			password: 'hunter2hunter2',
		})
	})

	it('previews by token without a workspace header', async () => {
		fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }))

		await api.invites.preview('a b')

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('/api/invites/preview?token=a%20b')
		expect((init.headers as Record<string, string>)['X-Workspace-Id']).toBeUndefined()
	})

	it('exposes Retry-After seconds on a 429 ApiError', async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), {
				status: 429,
				headers: { 'Retry-After': '14400' },
			}),
		)

		const err = await api.invites
			.create({ workspaceId: 'ws-1', email: 'ada@example.com', role: 'member' })
			.catch((e) => e)

		expect(err).toBeInstanceOf(ApiError)
		expect(err.status).toBe(429)
		expect(err.retryAfter).toBe(14400)
	})

	it('leaves retryAfter unset when the header is missing', async () => {
		fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 409 }))

		const err = await api.invites.revoke('inv-1').catch((e) => e)

		expect(err.retryAfter).toBeUndefined()
	})
})

describe('events.historyUpTo', () => {
	const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i + 1 }))
	const ok = (rows: unknown[]) => new Response(JSON.stringify(rows), { status: 200 })
	const urls = () => fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]))

	it('never asks the server for more than its 100-row page limit', async () => {
		fetchSpy
			.mockResolvedValueOnce(ok(page(100)))
			.mockResolvedValueOnce(ok(page(100, 100)))
			.mockResolvedValueOnce(ok(page(40, 200)))

		const rows = await api.events.historyUpTo('ws-1', { after: '2026-09-22T09:00:00Z' }, 500)

		expect(rows).toHaveLength(240)
		for (const url of urls())
			expect(Number(new URL(url, 'http://x').searchParams.get('limit'))).toBeLessThanOrEqual(100)
	})

	it('pages forward with offset and stops at a short page', async () => {
		fetchSpy.mockResolvedValueOnce(ok(page(100))).mockResolvedValueOnce(ok(page(7, 100)))

		await api.events.historyUpTo('ws-1', { after: '2026-09-22T09:00:00Z' }, 500)

		expect(fetchSpy).toHaveBeenCalledTimes(2)
		const second = new URL(urls()[1], 'http://x').searchParams
		expect(second.get('offset')).toBe('100')
		expect(second.get('after')).toBe('2026-09-22T09:00:00Z')
	})

	it('stops at maxEvents and trims the last page request to what is left', async () => {
		fetchSpy.mockResolvedValueOnce(ok(page(100))).mockResolvedValueOnce(ok(page(50, 100)))

		const rows = await api.events.historyUpTo('ws-1', {}, 150)

		expect(rows).toHaveLength(150)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(new URL(urls()[1], 'http://x').searchParams.get('limit')).toBe('50')
	})
})
