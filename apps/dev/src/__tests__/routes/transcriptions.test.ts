import { OpenAPIHono } from '@hono/zod-openapi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewerReadOnlyError } from '../../lib/workspace-auth'
import { jsonRequest } from '../helpers'
import { createTestContext, withTestEnv } from '../setup'

const { default: transcriptionsRoutes } = await import('../../routes/transcriptions')

// authMiddleware puts the caller's role on the context when X-Workspace-Id is
// sent; the test app stands in for that with an X-Test-Role header.
function post(body: unknown, role: string | null = 'member') {
	const app = new OpenAPIHono()
	const { db } = createTestContext()
	withTestEnv(app as never, db)
	app.use('*', async (c, next) => {
		const testRole = c.req.header('X-Test-Role')
		if (testRole) c.set('workspaceRole' as never, testRole as never)
		await next()
	})
	app.onError((err, c) =>
		c.json({ error: err.message }, err instanceof ViewerReadOnlyError ? 403 : 500),
	)
	app.route('/api/transcriptions', transcriptionsRoutes as never)
	return app.request(
		jsonRequest('POST', '/api/transcriptions', body, role ? { 'X-Test-Role': role } : {}),
	)
}

beforeEach(() => {
	vi.stubEnv('MASKIN_FALLBACK_OPENROUTER_KEY', 'test-key')
	vi.stubEnv('MASKIN_TRANSCRIPTION_MODEL', '')
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('POST /api/transcriptions', () => {
	it('sends the WAV to the Voxtral model on OpenRouter and returns the text', async () => {
		const fetchMock = vi.fn(async () => Response.json({ text: ' hello world ' }))
		vi.stubGlobal('fetch', fetchMock)

		const res = await post({ audio: 'QUJD' })

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ text: 'hello world' })
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
		expect(JSON.parse(String(init.body))).toEqual({
			model: 'mistralai/voxtral-small-transcribe-3-0',
			input_audio: { data: 'QUJD', format: 'wav' },
		})
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
	})

	it('honours MASKIN_TRANSCRIPTION_MODEL', async () => {
		vi.stubEnv('MASKIN_TRANSCRIPTION_MODEL', 'mistralai/voxtral-mini-transcribe-3-0')
		const fetchMock = vi.fn(async () => Response.json({ text: 'x' }))
		vi.stubGlobal('fetch', fetchMock)

		await post({ audio: 'QUJD' })

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(JSON.parse(String(init.body)).model).toBe('mistralai/voxtral-mini-transcribe-3-0')
	})

	it('400s when the audio is missing', async () => {
		const res = await post({})
		expect(res.status).toBe(400)
	})

	it('400s without the workspace header', async () => {
		const res = await post({ audio: 'QUJD' }, null)
		expect(res.status).toBe(400)
	})

	it('refuses a read-only viewer', async () => {
		const res = await post({ audio: 'QUJD' }, 'viewer')
		expect(res.status).toBe(403)
	})

	it('500s when no OpenRouter key is configured', async () => {
		vi.stubEnv('MASKIN_FALLBACK_OPENROUTER_KEY', '')
		const res = await post({ audio: 'QUJD' })
		expect(res.status).toBe(500)
	})

	it('502s when the provider fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('boom', { status: 500 })),
		)
		const res = await post({ audio: 'QUJD' })
		expect(res.status).toBe(502)
	})

	it('429s when the provider rate limits', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('slow down', { status: 429 })),
		)
		const res = await post({ audio: 'QUJD' })
		expect(res.status).toBe(429)
	})
})
