import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signGuestSessionId } from '../../lib/guest-session'
import type { AnthropicStreamChunk } from '../../lib/llm/anthropic'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Mock the LLM adapter so tests never reach Anthropic.
const streamMock = vi.fn<[], AsyncGenerator<AnthropicStreamChunk>>()

vi.mock('../../lib/llm/anthropic', () => {
	class AnthropicAdapter {
		async *chatStream(): AsyncGenerator<AnthropicStreamChunk> {
			yield* streamMock()
		}
	}
	return { AnthropicAdapter }
})

function clearEnv(key: string) {
	// Assigning `undefined` to process.env[key] coerces to the string 'undefined',
	// which keeps the key truthy. Reflect.deleteProperty actually removes it.
	Reflect.deleteProperty(process.env, key)
}

const { default: publicBetStrategistRoutes } = await import('../../routes/public-bet-strategist')

const VALID_DRAFT = `## Hypothesis
We believe a hero prompt bar will lift signups by 15%.

## Success
Lift landing → signup by 15% within 4 weeks.

## Exit criteria
If by 2026-08-15 conversion is below 8%, stop.

## First test
Blind-score 30 cold drafts with 3 PM friends.`

const MALFORMED_DRAFT = 'Just a vague response without any required headings.'

const SECRET = 'x'.repeat(48)

function happyPathStream(content: string) {
	return async function* (): AsyncGenerator<AnthropicStreamChunk> {
		yield { type: 'text', text: content }
		yield { type: 'usage', inputTokens: 100, outputTokens: 200 }
		yield { type: 'done' }
	}
}

async function readAllSSE(res: Response): Promise<string> {
	const reader = res.body?.getReader()
	if (!reader) return ''
	const decoder = new TextDecoder()
	let out = ''
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		out += decoder.decode(value, { stream: true })
	}
	return out
}

describe('POST /api/public/bet-strategist/drafts', () => {
	beforeEach(() => {
		process.env.GUEST_SESSION_SECRET = SECRET
		process.env.ANTHROPIC_API_KEY = 'test-key'
		streamMock.mockReset()
	})

	afterEach(() => {
		clearEnv('GUEST_SESSION_SECRET')
		clearEnv('ANTHROPIC_API_KEY')
	})

	it('streams a draft, persists it, and sets a signed cookie when throttle passes', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
		)
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]]
		mockResults.insertQueue = [
			[{ id: '00000000-0000-0000-0000-000000000aaa' }],
			[{ id: '00000000-0000-0000-0000-000000000bbb' }],
		]
		streamMock.mockImplementation(happyPathStream(VALID_DRAFT))

		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/drafts', { prompt: 'I want PM tooling' }),
		)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/event-stream')

		const cookie = res.headers.get('Set-Cookie') ?? ''
		expect(cookie).toMatch(/^maskin_guest=/)
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('SameSite=Lax')

		const body = await readAllSSE(res)
		expect(body).toContain('event: draft_started')
		expect(body).toContain('event: delta')
		expect(body).toContain('event: done')
		expect(body).toContain('"isMalformed":false')

		const updates = calls.updates as Array<{
			status?: string
			metadata?: { isMalformed?: boolean; inputTokens?: number }
		}>
		const draftUpdate = updates.find((u) => u.status === 'completed')
		expect(draftUpdate).toBeDefined()
		expect(draftUpdate?.metadata?.isMalformed).toBe(false)
		expect(draftUpdate?.metadata?.inputTokens).toBe(100)
	})

	it('marks a malformed draft and surfaces it on the done event', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
		)
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]]
		mockResults.insertQueue = [
			[{ id: '00000000-0000-0000-0000-000000000ccc' }],
			[{ id: '00000000-0000-0000-0000-000000000ddd' }],
		]
		streamMock.mockImplementation(happyPathStream(MALFORMED_DRAFT))

		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/drafts', { prompt: 'hi' }),
		)
		const body = await readAllSSE(res)
		expect(body).toContain('"isMalformed":true')

		const draftUpdate = (calls.updates as Array<{ status?: string }>).find(
			(u) => u.status === 'malformed',
		)
		expect(draftUpdate).toBeDefined()
	})

	it('returns 429 with cookie_quota when the cookie already has 3 drafts', async () => {
		const { app, mockResults } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
		)
		mockResults.selectQueue = [[{ count: 3 }]]

		const signed = signGuestSessionId('abcdef0123456789', SECRET)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/bet-strategist/drafts',
				{ prompt: 'hi' },
				{ Cookie: `maskin_guest=${signed}` },
			),
		)

		expect(res.status).toBe(429)
		const json = (await res.json()) as { error: { code: string; message: string } }
		expect(json.error.code).toBe('RATE_LIMITED')
		expect(json.error.message).toContain('Sign up')
	})

	it('returns 429 with ip_rate when the IP has hit 5/min', async () => {
		const { app, mockResults } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
		)
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 5 }]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/bet-strategist/drafts',
				{ prompt: 'hi' },
				{ 'X-Forwarded-For': '203.0.113.7' },
			),
		)

		expect(res.status).toBe(429)
		expect(res.headers.get('Retry-After')).toBe('60')
	})

	it('rejects an empty prompt with 400', async () => {
		const { app } = createTestApp(publicBetStrategistRoutes, '/api/public/bet-strategist')
		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/drafts', { prompt: '' }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
		clearEnv('ANTHROPIC_API_KEY')
		const { app } = createTestApp(publicBetStrategistRoutes, '/api/public/bet-strategist')
		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/drafts', { prompt: 'hi' }),
		)
		expect(res.status).toBe(503)
	})

	it('persists a partial draft as failed with metadata.aborted when the client disconnects', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
		)
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]]
		mockResults.insertQueue = [
			[{ id: '00000000-0000-0000-0000-000000000eee' }],
			[{ id: '00000000-0000-0000-0000-000000000fff' }],
		]

		const ac = new AbortController()
		// First chunk yields, second chunk waits until aborted then completes;
		// the route's aborted check between yields drops the second.
		streamMock.mockImplementation(async function* () {
			yield { type: 'text', text: 'partial start' }
			ac.abort()
			yield { type: 'text', text: 'never seen by route' }
			yield { type: 'usage', inputTokens: 50, outputTokens: 80 }
			yield { type: 'done' }
		})

		const res = await app.request(
			new Request('http://localhost/api/public/bet-strategist/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: 'hi' }),
				signal: ac.signal,
			}),
		)

		// Drain whatever the stream produced before abort kicked in.
		const reader = res.body?.getReader()
		if (reader) {
			try {
				while (true) {
					const { done } = await reader.read()
					if (done) break
				}
			} catch {
				// Aborted reads can throw; we don't care about the wire output here.
			}
		}

		const updates = calls.updates as Array<{
			status?: string
			metadata?: { isMalformed?: boolean; aborted?: boolean }
		}>
		const draftUpdate = updates.find((u) => u.metadata?.aborted === true)
		expect(draftUpdate).toBeDefined()
		expect(draftUpdate?.status).toBe('failed')
		expect(draftUpdate?.metadata?.isMalformed).toBe(false)
	})
})
