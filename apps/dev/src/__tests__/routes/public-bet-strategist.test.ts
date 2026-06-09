import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import publicBetStrategistRoutes, { _resetIpBuckets } from '../../routes/public-bet-strategist'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const BASE = '/api/public/bet-strategist'

const validDraftBody = {
	prompt: 'Teams waste hours in status meetings that could be async updates.',
	guestSessionId: 'gsid-abc12345',
}

function mockFetch(content: string, status = 200) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: status >= 200 && status < 300,
			status,
			json: async () => ({
				choices: [{ message: { content } }],
			}),
		}),
	)
}

describe('POST /api/public/bet-strategist/drafts', () => {
	beforeEach(() => {
		_resetIpBuckets()
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		process.env.WORKSPACE_DAILY_DRAFT_CAP = '1000'
		process.env.PER_COOKIE_DRAFT_CAP = '3'
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = undefined
		process.env.WORKSPACE_DAILY_DRAFT_CAP = undefined
		process.env.PER_COOKIE_DRAFT_CAP = undefined
	})

	it('returns 200 with draft content on happy path', async () => {
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockFetch(
			'This is a well-formed bet draft with enough content to pass the malformed check and be meaningful.',
		)

		// selectQueue: [workspace daily count], [cookie daily count], [insert returning]
		mockResults.selectQueue = [[{ count: 5 }], [{ count: 0 }]]
		mockResults.insert = [{ id: 'new-draft-id' }]

		const res = await app.request(
			jsonRequest('POST', `${BASE}/drafts`, validDraftBody, {}, { remoteAddress: '127.0.0.1' }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ id: 'new-draft-id', isMalformed: false })
		expect(typeof body.content).toBe('string')
	})

	it('returns 503 when workspace daily cap is reached', async () => {
		process.env.WORKSPACE_DAILY_DRAFT_CAP = '10'
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockFetch('irrelevant')

		mockResults.select = [{ count: 10 }]

		const res = await app.request(
			jsonRequest('POST', `${BASE}/drafts`, validDraftBody, {}, { remoteAddress: '127.0.0.1' }),
		)

		expect(res.status).toBe(503)
		const body = await res.json()
		expect(body.error.code).toBe('INTERNAL_ERROR')
	})

	it('returns 429 when per-cookie daily cap is reached', async () => {
		process.env.PER_COOKIE_DRAFT_CAP = '3'
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockFetch('irrelevant')

		// selectQueue: workspace count (under cap), then cookie count (at cap)
		mockResults.selectQueue = [[{ count: 5 }], [{ count: 3 }]]

		const res = await app.request(
			jsonRequest('POST', `${BASE}/drafts`, validDraftBody, {}, { remoteAddress: '127.0.0.1' }),
		)

		expect(res.status).toBe(429)
		const body = await res.json()
		expect(body.error.code).toBe('RATE_LIMITED')
	})

	it('returns 429 when per-IP per-minute bucket is exhausted', async () => {
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockFetch('irrelevant')
		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }]]
		mockResults.insert = [{ id: 'id' }]

		// Drain the 5-token bucket with 5 requests, then the 6th should be rejected
		for (let i = 0; i < 5; i++) {
			await app.request(
				jsonRequest('POST', `${BASE}/drafts`, validDraftBody, {}, { remoteAddress: '10.0.0.1' }),
			)
			mockResults.selectQueue = [[{ count: i + 1 }], [{ count: i + 1 }]]
		}

		const res = await app.request(
			jsonRequest('POST', `${BASE}/drafts`, validDraftBody, {}, { remoteAddress: '10.0.0.1' }),
		)

		expect(res.status).toBe(429)
		const body = await res.json()
		expect(body.error.code).toBe('RATE_LIMITED')
	})

	it('marks draft isMalformed when LLM returns a short response', async () => {
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockFetch('ok') // too short, < 50 chars

		mockResults.selectQueue = [[{ count: 0 }], [{ count: 0 }]]
		mockResults.insert = [{ id: 'malformed-id' }]

		const res = await app.request(
			jsonRequest('POST', `${BASE}/drafts`, validDraftBody, {}, { remoteAddress: '127.0.0.1' }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.isMalformed).toBe(true)
	})

	it('returns 400 for invalid body', async () => {
		const { app } = createTestApp(publicBetStrategistRoutes, BASE)

		const res = await app.request(
			jsonRequest(
				'POST',
				`${BASE}/drafts`,
				{ prompt: 'too short' },
				{},
				{ remoteAddress: '127.0.0.1' },
			),
		)

		expect(res.status).toBe(400)
	})
})

describe('POST /api/public/bet-strategist/claim', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns claimed drafts for a valid guestSessionId', async () => {
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockResults.select = [
			{ id: 'draft-1', title: 'Async standup bet' },
			{ id: 'draft-2', title: null },
		]

		const res = await app.request(
			jsonRequest('POST', `${BASE}/claim`, {
				workspace_id: 'a0000000-0000-0000-0000-000000000001',
				guestSessionId: 'gsid-abc12345',
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.claimed).toHaveLength(2)
		expect(body.claimed[0]).toMatchObject({ id: 'draft-1', title: 'Async standup bet' })
	})

	it('returns empty claimed array when no guestSessionId is provided', async () => {
		const { app } = createTestApp(publicBetStrategistRoutes, BASE)

		const res = await app.request(
			jsonRequest('POST', `${BASE}/claim`, {
				workspace_id: 'a0000000-0000-0000-0000-000000000001',
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.claimed).toEqual([])
	})

	it('returns 400 for invalid workspace_id', async () => {
		const { app } = createTestApp(publicBetStrategistRoutes, BASE)

		const res = await app.request(
			jsonRequest('POST', `${BASE}/claim`, { workspace_id: 'not-a-uuid' }),
		)

		expect(res.status).toBe(400)
	})

	it('returns identical results for two concurrent calls (idempotent read)', async () => {
		const { app, mockResults } = createTestApp(publicBetStrategistRoutes, BASE)
		mockResults.select = [{ id: 'draft-1', title: 'Async standup bet' }]

		const claimBody = {
			workspace_id: 'a0000000-0000-0000-0000-000000000001',
			guestSessionId: 'gsid-concurrent',
		}

		const [res1, res2] = await Promise.all([
			app.request(jsonRequest('POST', `${BASE}/claim`, claimBody)),
			app.request(jsonRequest('POST', `${BASE}/claim`, claimBody)),
		])

		expect(res1.status).toBe(200)
		expect(res2.status).toBe(200)

		const [body1, body2] = await Promise.all([res1.json(), res2.json()])
		expect(body1).toEqual(body2)
		expect(body1.claimed).toHaveLength(1)
	})
})
