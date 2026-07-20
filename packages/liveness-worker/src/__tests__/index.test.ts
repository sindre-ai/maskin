import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SILENCE_KEY } from '../dedup'
import { type Env, runTick } from '../index'

/** In-memory KV stub — exposes just the surface we use. */
function makeKv(initial?: Record<string, string>): {
	kv: KVNamespace
	store: Map<string, string>
} {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	const kv = {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
	} as unknown as KVNamespace
	return { kv, store }
}

type FetchCall = { url: string; init: RequestInit | undefined }

function makeFetch(
	responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): {
	fetchImpl: typeof fetch
	calls: FetchCall[]
} {
	const calls: FetchCall[] = []
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
		calls.push({ url: u, init })
		return responder(u, init)
	}) as unknown as typeof fetch
	return { fetchImpl, calls }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
	const { kv } = makeKv()
	return {
		HEARTBEAT_URL: 'https://app.example/api/internal/fleet-heartbeat',
		HEARTBEAT_SHARED_SECRET: 'secret',
		SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/xxx',
		GH_DISPATCH_TOKEN: 'ghp_xxx',
		SILENCE_THRESHOLD_MIN: '8',
		ACTIVE_HOURS: '07:00-23:00',
		ACTIVE_TIMEZONE: 'Europe/Copenhagen',
		GH_DISPATCH_REPO: 'sindre-ai/maskin',
		BET_URL: 'https://maskin.io/w/objects/bet',
		SILENCE_STATE: kv,
		...overrides,
	}
}

// A moment inside 07:00–23:00 Europe/Copenhagen for both CET and CEST.
const IN_WINDOW_UTC = new Date('2026-07-15T12:00:00.000Z') // 14:00 CEST
const OUT_WINDOW_UTC = new Date('2026-07-15T03:00:00.000Z') // 05:00 CEST — before 07:00

const heartbeatOk = (minutesSince: number) =>
	new Response(
		JSON.stringify({
			latest_completed_at: new Date(IN_WINDOW_UTC.getTime() - minutesSince * 60_000).toISOString(),
			minutes_since: minutesSince,
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	)

describe('runTick — silence eval + dedup + alerts', () => {
	beforeEach(() => {
		vi.useRealTimers()
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('does not page and does not touch KV when the heartbeat is fresh', async () => {
		const { kv, store } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl, calls } = makeFetch((url) => {
			if (url.includes('/fleet-heartbeat')) return heartbeatOk(2)
			throw new Error(`unexpected fetch: ${url}`)
		})
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.silent).toBe(false)
		expect(res.paged).toBe(false)
		expect(calls.some((c) => c.url.includes('slack'))).toBe(false)
		expect(calls.some((c) => c.url.includes('api.github.com'))).toBe(false)
		expect(store.get(SILENCE_KEY)).toBeUndefined()
	})

	it('clears the silence flag when a fresh heartbeat returns after an outage', async () => {
		const { kv, store } = makeKv({ [SILENCE_KEY]: '2026-07-15T11:00:00.000Z' })
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl } = makeFetch(() => heartbeatOk(1))
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.silent).toBe(false)
		expect(store.get(SILENCE_KEY)).toBeUndefined()
	})

	it('pages on threshold breach inside the active window, hitting both Slack and GH dispatch', async () => {
		const { kv, store } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl, calls } = makeFetch((url) => {
			if (url.includes('/fleet-heartbeat')) return heartbeatOk(12)
			return new Response('', { status: 200 })
		})
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.silent).toBe(true)
		expect(res.paged).toBe(true)
		expect(res.slack?.ok).toBe(true)
		expect(res.dispatch?.ok).toBe(true)
		expect(calls.some((c) => c.url.includes('hooks.slack.com'))).toBe(true)
		expect(
			calls.some((c) => c.url.includes('api.github.com/repos/sindre-ai/maskin/dispatches')),
		).toBe(true)
		// Flag raised so a second tick within the same window won't double-page.
		expect(store.get(SILENCE_KEY)).toBeDefined()
	})

	it('does not page on threshold breach outside the active window', async () => {
		const { kv, store } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl, calls } = makeFetch(() => heartbeatOk(30))
		const res = await runTick(env, { fetchImpl, now: () => OUT_WINDOW_UTC })
		expect(res.silent).toBe(true)
		expect(res.paged).toBe(false)
		expect(calls.some((c) => c.url.includes('slack') || c.url.includes('api.github.com'))).toBe(
			false,
		)
		// Flag deliberately not touched off-hours — see runTick comment.
		expect(store.get(SILENCE_KEY)).toBeUndefined()
	})

	it('pages on a 5xx heartbeat (worker treats non-2xx as silence)', async () => {
		const { kv } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl, calls } = makeFetch((url) => {
			if (url.includes('/fleet-heartbeat')) return new Response('boom', { status: 503 })
			return new Response('', { status: 200 })
		})
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.paged).toBe(true)
		expect(res.reason).toBe('non_2xx')
		expect(calls.some((c) => c.url.includes('hooks.slack.com'))).toBe(true)
	})

	it('pages on a network error (worker treats unreachable as silence)', async () => {
		const { kv } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		let firstCall = true
		const { fetchImpl, calls } = makeFetch((url) => {
			if (firstCall && url.includes('/fleet-heartbeat')) {
				firstCall = false
				throw new Error('ECONNREFUSED')
			}
			return new Response('', { status: 200 })
		})
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.paged).toBe(true)
		expect(res.reason).toBe('network_error')
		expect(calls.some((c) => c.url.includes('hooks.slack.com'))).toBe(true)
	})

	it('dedups: a second silent tick with the flag already set does not page again', async () => {
		const { kv } = makeKv({ [SILENCE_KEY]: '2026-07-15T11:50:00.000Z' })
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl, calls } = makeFetch(() => heartbeatOk(15))
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.silent).toBe(true)
		expect(res.paged).toBe(false)
		expect(calls.some((c) => c.url.includes('slack') || c.url.includes('api.github.com'))).toBe(
			false,
		)
	})

	it('null latest_completed_at (empty sessions) pages inside the window', async () => {
		const { kv } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl } = makeFetch((url) => {
			if (url.includes('/fleet-heartbeat')) {
				return new Response(JSON.stringify({ latest_completed_at: null, minutes_since: null }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			}
			return new Response('', { status: 200 })
		})
		const res = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(res.paged).toBe(true)
		expect(res.reason).toBe('null_latest')
	})

	it('does not double-page across two consecutive silent ticks in one window', async () => {
		const { kv } = makeKv()
		const env = makeEnv({ SILENCE_STATE: kv })
		const { fetchImpl, calls } = makeFetch((url) => {
			if (url.includes('/fleet-heartbeat')) return heartbeatOk(20)
			return new Response('', { status: 200 })
		})
		const first = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		const second = await runTick(env, { fetchImpl, now: () => IN_WINDOW_UTC })
		expect(first.paged).toBe(true)
		expect(second.paged).toBe(false)
		const slackCalls = calls.filter((c) => c.url.includes('hooks.slack.com'))
		const ghCalls = calls.filter((c) => c.url.includes('api.github.com'))
		expect(slackCalls.length).toBe(1)
		expect(ghCalls.length).toBe(1)
	})
})
