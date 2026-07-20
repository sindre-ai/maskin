import { describe, expect, it, vi } from 'vitest'
import { buildGhDispatchBody, buildSlackMessage, postGhDispatch, postSlack } from '../alerts'
import type { SilenceVerdict } from '../silence'

const BET_URL = 'https://maskin.io/w/objects/bet-id'

function silentVerdict(
	overrides: Partial<Extract<SilenceVerdict, { silent: true }>> = {},
): Extract<SilenceVerdict, { silent: true }> {
	return {
		silent: true,
		reason: 'threshold_exceeded',
		minutes_since: 12,
		latest_completed_at: '2026-07-02T00:00:00.000Z',
		...overrides,
	}
}

describe('buildSlackMessage', () => {
	it('names silence duration, last-heartbeat timestamp, and links the bet on a threshold breach', () => {
		const msg = buildSlackMessage({ detectedAt: new Date(), verdict: silentVerdict() }, BET_URL)
		expect(msg.text).toContain('12 min since the last completed session')
		expect(msg.text).toContain('2026-07-02T00:00:00.000Z')
		expect(msg.text).toContain(BET_URL)
	})

	it('explains a non_2xx status in the message', () => {
		const msg = buildSlackMessage(
			{
				detectedAt: new Date(),
				verdict: silentVerdict({
					reason: 'non_2xx',
					status: 503,
					minutes_since: null,
					latest_completed_at: null,
				}),
			},
			BET_URL,
		)
		expect(msg.text).toContain('HTTP 503')
		expect(msg.text).toContain('(never)')
	})

	it('explains a network error with the underlying message', () => {
		const msg = buildSlackMessage(
			{
				detectedAt: new Date(),
				verdict: silentVerdict({
					reason: 'network_error',
					error_message: 'ECONNREFUSED',
					minutes_since: null,
					latest_completed_at: null,
				}),
			},
			BET_URL,
		)
		expect(msg.text).toContain('ECONNREFUSED')
	})
})

describe('buildGhDispatchBody', () => {
	it('produces the canonical fleet.silence_detected payload', () => {
		const detectedAt = new Date('2026-07-02T00:12:34.000Z')
		const body = buildGhDispatchBody({ detectedAt, verdict: silentVerdict() })
		expect(body).toEqual({
			event_type: 'fleet.silence_detected',
			client_payload: {
				latest_completed_at: '2026-07-02T00:00:00.000Z',
				minutes_since: 12,
				source: 'liveness-worker',
				detected_at: '2026-07-02T00:12:34.000Z',
			},
		})
	})
})

describe('postSlack', () => {
	it('POSTs JSON to the webhook and reports the status', async () => {
		const fetchImpl = vi.fn(async (url, init) => {
			expect(url).toBe('https://hooks.slack.com/services/xxx')
			expect(init?.method).toBe('POST')
			expect((init?.headers as Record<string, string>)?.['Content-Type']).toBe('application/json')
			expect(JSON.parse(init?.body as string)).toEqual({ text: 'hello' })
			return new Response('ok', { status: 200 })
		}) as unknown as typeof fetch
		const res = await postSlack(
			'https://hooks.slack.com/services/xxx',
			{ text: 'hello' },
			fetchImpl,
		)
		expect(res.ok).toBe(true)
		expect(res.status).toBe(200)
	})
})

describe('postGhDispatch', () => {
	it('POSTs to /repos/<repo>/dispatches with the right auth + accept headers and body shape', async () => {
		const fetchImpl = vi.fn(async (url, init) => {
			expect(url).toBe('https://api.github.com/repos/sindre-ai/maskin/dispatches')
			expect(init?.method).toBe('POST')
			const headers = init?.headers as Record<string, string>
			expect(headers.Authorization).toBe('Bearer ghp_xxx')
			expect(headers.Accept).toBe('application/vnd.github+json')
			const body = JSON.parse(init?.body as string)
			expect(body.event_type).toBe('fleet.silence_detected')
			expect(body.client_payload.source).toBe('liveness-worker')
			return new Response(null, { status: 204 })
		}) as unknown as typeof fetch
		const res = await postGhDispatch(
			'sindre-ai/maskin',
			'ghp_xxx',
			buildGhDispatchBody({ detectedAt: new Date(), verdict: silentVerdict() }),
			fetchImpl,
		)
		expect(res.ok).toBe(true)
		expect(res.status).toBe(204)
	})
})
