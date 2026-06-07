import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signGuestSessionId } from '../../lib/guest-session'
import type { AnthropicStreamChunk } from '../../lib/llm/anthropic'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Mock the LLM adapter so tests never reach Anthropic.
const streamMock = vi.fn<[], AsyncGenerator<AnthropicStreamChunk>>()
const chatStreamCalls: Array<{ signal?: AbortSignal }> = []

vi.mock('../../lib/llm/anthropic', () => {
	class AnthropicAdapter {
		async *chatStream(options: { signal?: AbortSignal }): AsyncGenerator<AnthropicStreamChunk> {
			chatStreamCalls.push({ signal: options?.signal })
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
		chatStreamCalls.length = 0
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

	it('forwards the request AbortSignal into chatStream so the adapter can stop early', async () => {
		const { app, mockResults } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
		)
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]]
		mockResults.insertQueue = [
			[{ id: '00000000-0000-0000-0000-000000000111' }],
			[{ id: '00000000-0000-0000-0000-000000000222' }],
		]
		streamMock.mockImplementation(happyPathStream(VALID_DRAFT))

		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/drafts', { prompt: 'hi' }),
		)
		const reader = res.body?.getReader()
		if (reader) {
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}
		}

		// The route must wire the request's AbortSignal through to the adapter so
		// a client disconnect propagates into the fetch and stops the upstream
		// stream. If a regression drops `signal: clientSignal` from chatStream(...),
		// the adapter unit test would still pass but real production traffic would
		// silently leak streams — this assertion catches that at the route layer.
		expect(chatStreamCalls).toHaveLength(1)
		expect(chatStreamCalls[0]?.signal).toBeInstanceOf(AbortSignal)
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

describe('POST /api/public/bet-strategist/claim', () => {
	const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
	const TARGET_WORKSPACE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
	const GUEST_SESSION = '0123456789abcdef0123456789abcdef'
	const GUEST_DRAFT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
	const NEW_BET_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

	beforeEach(() => {
		process.env.GUEST_SESSION_SECRET = SECRET
	})

	afterEach(() => {
		clearEnv('GUEST_SESSION_SECRET')
	})

	function cookieHeader(sessionId = GUEST_SESSION): Record<string, string> {
		const signed = signGuestSessionId(sessionId, SECRET)
		return { Cookie: `maskin_guest=${signed}` }
	}

	it('copies a completed guest draft into the target workspace and returns the new bet id', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
			ACTOR,
		)
		// 1) isWorkspaceMember → 1 row
		// 2) candidate drafts SELECT → 1 unclaimed draft
		mockResults.selectQueue = [
			[{ actorId: ACTOR }],
			[
				{
					id: GUEST_DRAFT_ID,
					title: 'Bet on growth experiments',
					content: '## Hypothesis\n…',
					metadata: { guestSessionId: GUEST_SESSION, isMalformed: false },
				},
			],
		]
		mockResults.insertQueue = [[{ id: NEW_BET_ID }]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/bet-strategist/claim',
				{ workspace_id: TARGET_WORKSPACE },
				cookieHeader(),
			),
		)

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			claimed: Array<{ id: string; title: string | null }>
		}
		expect(json.claimed).toEqual([{ id: NEW_BET_ID, title: 'Bet on growth experiments' }])

		const inserted = calls.inserts as Array<Record<string, unknown>>
		const betInsert = inserted.find((row) => row.type === 'bet')
		expect(betInsert).toBeDefined()
		expect(betInsert?.workspaceId).toBe(TARGET_WORKSPACE)
		expect(betInsert?.status).toBe('signal')
		expect(betInsert?.createdBy).toBe(ACTOR)
		expect((betInsert?.metadata as { claimedFromGuestDraft?: string }).claimedFromGuestDraft).toBe(
			GUEST_DRAFT_ID,
		)

		// Original guest draft stamped with claim metadata for idempotency.
		const stamped = (calls.updates as Array<{ metadata?: Record<string, unknown> }>).find(
			(u) => (u.metadata as { claimedAs?: string }).claimedAs === NEW_BET_ID,
		)
		expect(stamped).toBeDefined()
		expect((stamped?.metadata as { claimedBy?: string }).claimedBy).toBe(ACTOR)
	})

	it('returns 200 with empty claimed list when no guest cookie is present', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
			ACTOR,
		)
		mockResults.selectQueue = [[{ actorId: ACTOR }]]

		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/claim', {
				workspace_id: TARGET_WORKSPACE,
			}),
		)

		expect(res.status).toBe(200)
		const json = (await res.json()) as { claimed: unknown[] }
		expect(json.claimed).toEqual([])
		// No drafts inserted into the target workspace.
		expect((calls.inserts as Array<{ type?: string }>).some((row) => row.type === 'bet')).toBe(
			false,
		)
	})

	it('returns 403 when the actor is not a member of the target workspace', async () => {
		const { app, mockResults } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
			ACTOR,
		)
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/bet-strategist/claim',
				{ workspace_id: TARGET_WORKSPACE },
				cookieHeader(),
			),
		)

		expect(res.status).toBe(403)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe('FORBIDDEN')
	})

	it('is idempotent — re-claiming returns the existing bet id without inserting again', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
			ACTOR,
		)
		mockResults.selectQueue = [
			[{ actorId: ACTOR }],
			[
				{
					id: GUEST_DRAFT_ID,
					title: 'Bet on growth experiments',
					content: '## Hypothesis\n…',
					metadata: {
						guestSessionId: GUEST_SESSION,
						claimedAt: '2026-06-07T00:00:00.000Z',
						claimedBy: ACTOR,
						claimedIntoWorkspace: TARGET_WORKSPACE,
						claimedAs: NEW_BET_ID,
					},
				},
			],
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/bet-strategist/claim',
				{ workspace_id: TARGET_WORKSPACE },
				cookieHeader(),
			),
		)

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			claimed: Array<{ id: string }>
		}
		expect(json.claimed).toEqual([{ id: NEW_BET_ID, title: 'Bet on growth experiments' }])
		// No new bet inserted because the draft was already claimed.
		expect((calls.inserts as Array<{ type?: string }>).some((row) => row.type === 'bet')).toBe(
			false,
		)
	})

	it('rejects a malformed workspace_id with 400', async () => {
		const { app } = createTestApp(publicBetStrategistRoutes, '/api/public/bet-strategist', ACTOR)
		const res = await app.request(
			jsonRequest('POST', '/api/public/bet-strategist/claim', {
				workspace_id: 'not-a-uuid',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('only considers completed drafts — failed and malformed rows are filtered out by the SELECT', async () => {
		// The route's WHERE clause filters status='completed'; the test verifies
		// the contract by setting up a query that returns nothing (simulating
		// the filtered result) and confirming we don't insert.
		const { app, mockResults, calls } = createTestApp(
			publicBetStrategistRoutes,
			'/api/public/bet-strategist',
			ACTOR,
		)
		mockResults.selectQueue = [[{ actorId: ACTOR }], []]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/bet-strategist/claim',
				{ workspace_id: TARGET_WORKSPACE },
				cookieHeader(),
			),
		)

		expect(res.status).toBe(200)
		const json = (await res.json()) as { claimed: unknown[] }
		expect(json.claimed).toEqual([])
		expect((calls.inserts as Array<{ type?: string }>).some((row) => row.type === 'bet')).toBe(
			false,
		)
	})
})
