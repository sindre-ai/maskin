import { Hono } from 'hono'
import { routePath } from 'hono/route'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	LIST_READ_CACHE_TTL_MS,
	_resetListReadCache,
	cachedListRead,
	evictListReadsFor,
} from '../../lib/list-read-cache'
import { listReadCache } from '../../middleware/list-read-cache'

const WS_1 = 'ws-1'
const WS_2 = 'ws-2'

function createApp() {
	const calls: string[] = []
	const routes: string[] = []
	let status = 200
	const app = new Hono<{ Variables: { actorId: string } }>()

	// What request-timing sees once the request is answered.
	app.use('*', async (c, next) => {
		await next()
		routes.push(routePath(c))
	})

	app.use('*', async (c, next) => {
		const actorId = c.req.header('x-test-actor')
		if (actorId) c.set('actorId', actorId)
		await next()
	})
	app.use('*', listReadCache())

	for (const path of ['/api/actors', '/api/conversations', '/api/for-you', '/api/objects']) {
		app.get(path, async (c) => {
			const actor = c.get('actorId')
			calls.push(`${actor}:${path}`)
			// Yield so concurrent requests overlap.
			await Promise.resolve()
			c.header('X-Total-Count', '7')
			return c.json({ actor, n: calls.length, q: c.req.query() }, status as 200)
		})
	}
	app.post('/api/conversations', (c) => c.json({ ok: true }))
	app.post('/api/objects', (c) => c.json({ ok: true }))

	const get = (path: string, actor = 'actor-a', workspace: string = WS_1) =>
		app.request(path, { headers: { 'x-test-actor': actor, 'x-workspace-id': workspace } })
	const post = (path: string, actor = 'actor-a', workspace: string = WS_1) =>
		app.request(path, {
			method: 'POST',
			headers: { 'x-test-actor': actor, 'x-workspace-id': workspace },
		})

	return {
		get,
		post,
		calls,
		routes,
		setStatus: (s: number) => {
			status = s
		},
	}
}

beforeEach(() => {
	_resetListReadCache()
})

describe('listReadCache', () => {
	it('answers a repeat read from the cache, headers included', async () => {
		const { get, calls } = createApp()

		const first = await get('/api/actors')
		const second = await get('/api/actors')

		expect(calls).toHaveLength(1)
		expect(await second.json()).toEqual(await first.json())
		expect(second.headers.get('x-total-count')).toBe('7')
		expect(second.headers.get('content-type')).toContain('application/json')
	})

	it('keeps naming the real route when it answers from the cache', async () => {
		const { get, routes } = createApp()

		await get('/api/conversations')
		await get('/api/conversations')

		expect(routes).toEqual(['/api/conversations', '/api/conversations'])
	})

	it('never serves one actor the other actor body in the same workspace', async () => {
		const { get, calls } = createApp()

		const a = await (await get('/api/conversations', 'actor-a')).json()
		const b = await (await get('/api/conversations', 'actor-b')).json()

		expect(a.actor).toBe('actor-a')
		expect(b.actor).toBe('actor-b')
		expect(calls).toHaveLength(2)
	})

	it('keeps workspaces and query strings apart', async () => {
		const { get, calls } = createApp()

		await get('/api/conversations', 'actor-a', WS_1)
		await get('/api/conversations', 'actor-a', WS_2)
		await get('/api/conversations?unread_only=true', 'actor-a', WS_1)
		await get('/api/conversations?unread_only=true', 'actor-a', WS_1)

		expect(calls).toHaveLength(3)
	})

	it('treats the same query in a different parameter order as one read', async () => {
		const { get, calls } = createApp()

		await get('/api/actors?limit=5&offset=0')
		await get('/api/actors?offset=0&limit=5')

		expect(calls).toHaveLength(1)
	})

	it('shares one computation between concurrent identical requests', async () => {
		const { get, calls } = createApp()

		const bodies = await Promise.all([1, 2, 3].map(async () => (await get('/api/for-you')).json()))

		expect(calls).toHaveLength(1)
		expect(bodies[1]).toEqual(bodies[0])
	})

	it('does not cache routes outside the four hot reads', async () => {
		const { get, calls } = createApp()

		await get('/api/objects')
		await get('/api/objects')

		expect(calls).toHaveLength(2)
	})

	it('does not cache a For You read for another member', async () => {
		const { get, calls } = createApp()

		await get('/api/for-you?for_actor_id=actor-b')
		await get('/api/for-you?for_actor_id=actor-b')

		expect(calls).toHaveLength(2)
	})

	it('does not cache an error response', async () => {
		const { get, calls, setStatus } = createApp()

		setStatus(500)
		const failed = await get('/api/actors')
		setStatus(200)
		const retried = await get('/api/actors')

		expect(failed.status).toBe(500)
		expect(retried.status).toBe(200)
		expect(calls).toHaveLength(2)
	})

	it('clears the writer own entries on a write, and only theirs', async () => {
		const { get, post, calls } = createApp()
		await get('/api/conversations', 'actor-a')
		await get('/api/conversations', 'actor-b')

		await post('/api/conversations', 'actor-a')
		await get('/api/conversations', 'actor-a')
		await get('/api/conversations', 'actor-b')

		// a ran again after its own write; b was still served from the cache.
		expect(calls).toEqual([
			'actor-a:/api/conversations',
			'actor-b:/api/conversations',
			'actor-a:/api/conversations',
		])
	})

	it('clears the writer entries in every workspace', async () => {
		const { get, post, calls } = createApp()
		await get('/api/actors', 'actor-a', WS_1)
		await get('/api/actors', 'actor-a', WS_2)

		await post('/api/objects', 'actor-a', WS_1)
		await get('/api/actors', 'actor-a', WS_1)
		await get('/api/actors', 'actor-a', WS_2)

		expect(calls).toHaveLength(4)
	})

	it('passes through a request with no actor', async () => {
		const { calls } = createApp()
		const app = new Hono()
		app.use('*', listReadCache())
		app.get('/api/actors', (c) => {
			calls.push('anon')
			return c.json({})
		})

		await app.request('/api/actors')
		await app.request('/api/actors')

		expect(calls).toEqual(['anon', 'anon'])
	})
})

describe('cachedListRead', () => {
	const snapshot = { status: 200, body: '{}', headers: {} }

	it('recomputes once the TTL has passed', async () => {
		let n = 0
		const compute = async () => {
			n++
			return snapshot
		}

		await cachedListRead('k', 'actor-a', compute, 1_000)
		await cachedListRead('k', 'actor-a', compute, 1_000 + LIST_READ_CACHE_TTL_MS - 1)
		await cachedListRead('k', 'actor-a', compute, 1_000 + LIST_READ_CACHE_TTL_MS)

		expect(n).toBe(2)
	})

	it('drops a failed read so it is not served for the rest of the window', async () => {
		let n = 0
		await expect(
			cachedListRead(
				'k',
				'actor-a',
				async () => {
					n++
					throw new Error('db down')
				},
				1_000,
			),
		).rejects.toThrow('db down')
		await Promise.resolve()

		await cachedListRead(
			'k',
			'actor-a',
			async () => {
				n++
				return snapshot
			},
			1_001,
		)

		expect(n).toBe(2)
	})

	it('evicts every entry of one actor and leaves the others', async () => {
		let n = 0
		const compute = async () => {
			n++
			return snapshot
		}
		await cachedListRead('a1', 'actor-a', compute, 1_000)
		await cachedListRead('a2', 'actor-a', compute, 1_000)
		await cachedListRead('b1', 'actor-b', compute, 1_000)

		evictListReadsFor('actor-a')
		await cachedListRead('a1', 'actor-a', compute, 1_001)
		await cachedListRead('b1', 'actor-b', compute, 1_001)

		expect(n).toBe(4)
	})
})
