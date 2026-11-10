import { Hono } from 'hono'
import { CAP_RETRY_AFTER_S, inFlightCap } from '../../middleware/in-flight-cap'

function buildApp(options: { max: number; maxWaiting: number; maxWaitMs: number }) {
	const gates: Array<() => void> = []
	let running = 0
	let peak = 0
	const onRefuse = vi.fn()
	const app = new Hono()
	app.use(
		'*',
		inFlightCap({
			...options,
			keyOf: (c) => c.req.header('x-client') ?? undefined,
			skip: (c) => c.req.path === '/skipped',
			onRefuse,
		}),
	)
	const work = async (c: { json: (b: unknown) => Response }) => {
		running += 1
		peak = Math.max(peak, running)
		await new Promise<void>((resolve) => gates.push(resolve))
		running -= 1
		return c.json({ ok: true })
	}
	app.get('/slow', work)
	app.get('/skipped', work)
	return {
		app,
		onRefuse,
		release: () => gates.shift()?.(),
		releaseAll: () => {
			while (gates.length) gates.shift()?.()
		},
		peak: () => peak,
		running: () => running,
	}
}

const get = (app: Hono, client?: string, path = '/slow') =>
	app.request(path, { headers: client ? { 'x-client': client } : {} })
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('inFlightCap', () => {
	it('runs at most max requests of one client at once and queues the rest', async () => {
		const t = buildApp({ max: 2, maxWaiting: 10, maxWaitMs: 1000 })
		const results = [1, 2, 3, 4].map(() => get(t.app, 'a'))
		await tick()
		expect(t.running()).toBe(2)
		t.release()
		await tick()
		expect(t.running()).toBe(2)
		t.releaseAll()
		await tick()
		t.releaseAll()
		const responses = await Promise.all(results)
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200])
		expect(t.peak()).toBe(2)
	})

	it('refuses with 503 and Retry-After once the waiting line is full', async () => {
		const t = buildApp({ max: 1, maxWaiting: 1, maxWaitMs: 1000 })
		const first = get(t.app, 'a')
		const second = get(t.app, 'a')
		await tick()
		const third = await get(t.app, 'a')
		expect(third.status).toBe(503)
		expect(third.headers.get('Retry-After')).toBe(String(CAP_RETRY_AFTER_S))
		expect(t.onRefuse).toHaveBeenCalledTimes(1)
		t.releaseAll()
		await tick()
		t.releaseAll()
		expect((await first).status).toBe(200)
		expect((await second).status).toBe(200)
	})

	it('refuses a request that waited longer than maxWaitMs', async () => {
		const t = buildApp({ max: 1, maxWaiting: 5, maxWaitMs: 20 })
		const first = get(t.app, 'a')
		await tick()
		const waited = await get(t.app, 'a')
		expect(waited.status).toBe(503)
		t.releaseAll()
		expect((await first).status).toBe(200)
	})

	it('does not let one client slow another', async () => {
		const t = buildApp({ max: 1, maxWaiting: 0, maxWaitMs: 1000 })
		const a = get(t.app, 'a')
		await tick()
		const b = get(t.app, 'b')
		await tick()
		expect(t.running()).toBe(2)
		t.releaseAll()
		expect((await a).status).toBe(200)
		expect((await b).status).toBe(200)
	})

	it('leaves requests without a key, and skipped paths, uncapped', async () => {
		const t = buildApp({ max: 1, maxWaiting: 0, maxWaitMs: 1000 })
		const calls = [get(t.app), get(t.app), get(t.app, 'a', '/skipped'), get(t.app, 'a', '/skipped')]
		await tick()
		expect(t.running()).toBe(4)
		t.releaseAll()
		expect((await Promise.all(calls)).map((r) => r.status)).toEqual([200, 200, 200, 200])
	})

	it('frees the slot when the handler throws', async () => {
		const app = new Hono()
		app.use('*', inFlightCap({ max: 1, maxWaiting: 0, maxWaitMs: 10, keyOf: () => 'a' }))
		app.get('/boom', () => {
			throw new Error('boom')
		})
		app.onError((_e, c) => c.json({ error: true }, 500))
		expect((await app.request('/boom')).status).toBe(500)
		expect((await app.request('/boom')).status).toBe(500)
	})
})
