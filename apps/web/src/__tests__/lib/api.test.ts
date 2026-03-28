import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
	getApiKey: vi.fn(),
}))

import { ApiError, api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'

let fetchSpy: ReturnType<typeof vi.spyOn>

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

		const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
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

	it('throws ApiError with legacy string error format', async () => {
		const errorBody = { error: 'Not found' }
		fetchSpy.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 404 }))

		try {
			await api.objects.list('ws-1')
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
		} catch (err) {
			const apiErr = err as ApiError
			expect(apiErr.status).toBe(500)
			expect(apiErr.message).toBe('Internal Server Error')
		}
	})
})
