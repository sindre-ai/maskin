import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTrustedCidrs, extractClientIp } from '../../lib/trusted-proxy'
import publicLandingEventsRoutes, {
	_resetLandingEventBuckets,
} from '../../routes/public-landing-events'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Typed helper so tests can read inserts without casting.
type InsertValues = Record<string, unknown>

// Capture structured log lines. The route logs via the shared logger, which
// writes JSON to console.log/console.error. We hijack both so we can assert
// on the emitted log records without leaking to stdout during tests.
let logSpy: ReturnType<typeof vi.spyOn>

function capturedLogs(): Array<Record<string, unknown>> {
	return logSpy.mock.calls
		.map(([line]) => {
			try {
				return JSON.parse(String(line)) as Record<string, unknown>
			} catch {
				return null
			}
		})
		.filter((x): x is Record<string, unknown> => x !== null)
}

describe('POST /api/public/landing-events', () => {
	beforeEach(() => {
		_resetLandingEventBuckets()
		_resetTrustedCidrs()
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('accepts a valid batch, logs one landing-event per item, returns 204', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const events = [
			{
				name: 'page_view',
				anonId: 'anon-abcd1234',
				sessionId: 'sess-abcd1234',
				ts: '2026-06-07T20:30:00.000Z',
				props: { referrer: 'https://news.example' },
			},
			{
				name: 'prompt_submit',
				anonId: 'anon-abcd1234',
				sessionId: 'sess-abcd1234',
				props: { kind: 'text', promptChars: 142 },
			},
		]
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/landing-events',
				{ events },
				{ 'X-Forwarded-For': '1.2.3.4' },
				// 127.0.0.1 is in the default trusted CIDR list, so XFF is honoured.
				{ remoteAddress: '127.0.0.1' },
			),
		)

		expect(res.status).toBe(204)
		expect(await res.text()).toBe('')

		const logs = capturedLogs().filter((l) => l.msg === 'landing-event')
		expect(logs).toHaveLength(2)
		expect(logs[0]).toMatchObject({
			name: 'page_view',
			known: true,
			anonId: 'anon-abcd1234',
			sessionId: 'sess-abcd1234',
			ts: '2026-06-07T20:30:00.000Z',
			ip: '1.2.3.4',
		})
		expect(logs[1]).toMatchObject({ name: 'prompt_submit', known: true })
	})

	it('marks unknown event names as known=false but still logs them', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/public/landing-events',
				{ events: [{ name: 'experimental_event', anonId: 'anon-aaaa1111' }] },
				{ 'X-Forwarded-For': '5.6.7.8' },
				{ remoteAddress: '127.0.0.1' },
			),
		)

		expect(res.status).toBe(204)
		const logs = capturedLogs().filter((l) => l.msg === 'landing-event')
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({ name: 'experimental_event', known: false })
	})

	it('rejects an empty events array with 400 VALIDATION_ERROR', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const res = await app.request(jsonRequest('POST', '/api/public/landing-events', { events: [] }))
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('VALIDATION_ERROR')
	})

	it('rejects malformed JSON with 400 VALIDATION_ERROR', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const res = await app.request(
			new Request('http://localhost/api/public/landing-events', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not-json',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('rejects a batch with too short an anonId', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const res = await app.request(
			jsonRequest('POST', '/api/public/landing-events', {
				events: [{ name: 'page_view', anonId: 'short' }],
			}),
		)
		expect(res.status).toBe(400)
	})

	it('caps batch size at 20 events per request', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const events = Array.from({ length: 21 }, (_, i) => ({
			name: 'page_view',
			anonId: `anon-batch${String(i).padStart(4, '0')}`,
		}))
		const res = await app.request(jsonRequest('POST', '/api/public/landing-events', { events }))
		expect(res.status).toBe(400)
	})

	it('truncates oversized props so log lines stay bounded', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const huge = 'x'.repeat(5_000)
		const res = await app.request(
			jsonRequest('POST', '/api/public/landing-events', {
				events: [{ name: 'page_view', anonId: 'anon-trunc01', props: { blob: huge } }],
			}),
		)
		expect(res.status).toBe(204)
		const log = capturedLogs().find((l) => l.msg === 'landing-event')
		expect(log).toBeDefined()
		expect(log?.props).toMatchObject({ __truncated: true })
	})

	it('inserts a landing_signup row for signup_complete when no prior record exists', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicLandingEventsRoutes,
			'/api/public/landing-events',
		)
		// select returns empty — no existing signup for this anonId
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', '/api/public/landing-events', {
				events: [{ name: 'signup_complete', anonId: 'anon-newuser01' }],
			}),
		)

		expect(res.status).toBe(204)
		expect((calls.inserts as InsertValues[]).length).toBe(1)
		expect((calls.inserts as InsertValues[])[0]).toMatchObject({
			type: 'landing_signup',
			metadata: { anonId: 'anon-newuser01' },
		})
	})

	it('skips insert for signup_complete when a landing_signup row already exists (dedup)', async () => {
		const { app, mockResults, calls } = createTestApp(
			publicLandingEventsRoutes,
			'/api/public/landing-events',
		)
		// select returns a row — this anonId has already been counted
		mockResults.select = [{ id: 'existing-signup-id' }]

		const res = await app.request(
			jsonRequest('POST', '/api/public/landing-events', {
				events: [{ name: 'signup_complete', anonId: 'anon-dupuser01' }],
			}),
		)

		expect(res.status).toBe(204)
		expect((calls.inserts as InsertValues[]).length).toBe(0)
	})

	it('throttles a flood from the same IP with 429 RATE_LIMITED', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		const ip = '10.0.0.99'
		// Capacity is 120. Six batches of 20 drain it; the 7th call should 429.
		// Socket 127.0.0.1 is in the default trusted CIDR list so XFF is used.
		for (let i = 0; i < 6; i++) {
			const events = Array.from({ length: 20 }, (_, n) => ({
				name: 'page_view',
				anonId: `anon-flood${String(i)}${String(n).padStart(3, '0')}`,
			}))
			const ok = await app.request(
				jsonRequest(
					'POST',
					'/api/public/landing-events',
					{ events },
					{ 'X-Forwarded-For': ip },
					{ remoteAddress: '127.0.0.1' },
				),
			)
			expect(ok.status).toBe(204)
		}
		const blocked = await app.request(
			jsonRequest(
				'POST',
				'/api/public/landing-events',
				{ events: [{ name: 'page_view', anonId: 'anon-overflow01' }] },
				{ 'X-Forwarded-For': ip },
				{ remoteAddress: '127.0.0.1' },
			),
		)
		expect(blocked.status).toBe(429)
		expect(blocked.headers.get('Retry-After')).toBe('60')
		const body = (await blocked.json()) as { error: { code: string } }
		expect(body.error.code).toBe('RATE_LIMITED')
	})

	it('isolates buckets per IP so one flood does not block another', async () => {
		const { app } = createTestApp(publicLandingEventsRoutes, '/api/public/landing-events')
		// Drain ip-A. Both use 127.0.0.1 as the trusted socket so XFF is honoured.
		for (let i = 0; i < 6; i++) {
			const events = Array.from({ length: 20 }, (_, n) => ({
				name: 'page_view',
				anonId: `anon-ipA${String(i)}${String(n).padStart(3, '0')}`,
			}))
			await app.request(
				jsonRequest(
					'POST',
					'/api/public/landing-events',
					{ events },
					{ 'X-Forwarded-For': '20.0.0.1' },
					{ remoteAddress: '127.0.0.1' },
				),
			)
		}
		const blockedA = await app.request(
			jsonRequest(
				'POST',
				'/api/public/landing-events',
				{ events: [{ name: 'page_view', anonId: 'anon-ipA-x01' }] },
				{ 'X-Forwarded-For': '20.0.0.1' },
				{ remoteAddress: '127.0.0.1' },
			),
		)
		expect(blockedA.status).toBe(429)
		const okB = await app.request(
			jsonRequest(
				'POST',
				'/api/public/landing-events',
				{ events: [{ name: 'page_view', anonId: 'anon-ipB-y01' }] },
				{ 'X-Forwarded-For': '20.0.0.2' },
				{ remoteAddress: '127.0.0.1' },
			),
		)
		expect(okB.status).toBe(204)
	})
})

describe('extractClientIp — trusted-proxy CIDR validation', () => {
	beforeEach(() => {
		_resetTrustedCidrs()
	})

	it('uses XFF when socket is a loopback address (default trusted CIDR)', () => {
		expect(extractClientIp('127.0.0.1', '1.2.3.4')).toBe('1.2.3.4')
	})

	it('uses XFF when socket is an IPv6 loopback (default trusted CIDR)', () => {
		expect(extractClientIp('::1', '5.6.7.8')).toBe('5.6.7.8')
	})

	it('falls back to socket IP when socket is not a trusted proxy', () => {
		expect(extractClientIp('203.0.113.5', '1.2.3.4')).toBe('203.0.113.5')
	})

	it('falls back to unknown when socket is undefined', () => {
		expect(extractClientIp(undefined, '1.2.3.4')).toBe('unknown')
	})

	it('returns unknown when both socket and XFF are absent', () => {
		expect(extractClientIp(undefined, undefined)).toBe('unknown')
	})

	it('respects TRUSTED_PROXY_CIDRS env var for private ranges', () => {
		process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8'
		_resetTrustedCidrs()
		expect(extractClientIp('10.1.2.3', '1.2.3.4')).toBe('1.2.3.4')
		expect(extractClientIp('192.168.1.1', '1.2.3.4')).toBe('192.168.1.1')
		process.env.TRUSTED_PROXY_CIDRS = undefined
	})

	it('takes the first hop of a multi-hop XFF when proxy is trusted', () => {
		expect(extractClientIp('127.0.0.1', '1.2.3.4, 10.0.0.1, 172.16.0.1')).toBe('1.2.3.4')
	})

	it('ignores XFF when no trusted CIDRs are configured', () => {
		process.env.TRUSTED_PROXY_CIDRS = ''
		_resetTrustedCidrs()
		expect(extractClientIp('127.0.0.1', '1.2.3.4')).toBe('127.0.0.1')
		process.env.TRUSTED_PROXY_CIDRS = undefined
	})
})
