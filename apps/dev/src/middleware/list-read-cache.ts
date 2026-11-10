import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import {
	type ListReadSnapshot,
	cachedListRead,
	evictListReadsFor,
	isCacheableBody,
	listReadCacheKey,
} from '../lib/list-read-cache'

// Mount after authMiddleware: the cache is only read once the actor and workspace membership are proven.
const CACHED_LIST_PATHS = new Set(['/api/actors', '/api/conversations', '/api/for-you'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// The only response headers the list handlers set that a repeat read must carry.
const REPLAYED_HEADERS = ['content-type', 'x-total-count']

function routePathOf(path: string): string {
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function replay(snapshot: ListReadSnapshot) {
	return new Response(snapshot.body, { status: snapshot.status, headers: snapshot.headers })
}

// A request answered here never reaches its route, so Hono would leave the route index on this
// wildcard middleware and request-timing would log the hit as GET /api/*. Point the index back at
// the route the request was for, so route counts and database time stay per route.
function nameRouteAsHandler(c: Context, path: string) {
	const routes = matchedRoutes(c)
	for (let i = routes.length - 1; i >= 0; i--) {
		const route = routes[i]
		if (route && route.method === 'GET' && routePathOf(route.path) === path) {
			c.req.routeIndex = i
			return
		}
	}
}

export function listReadCache() {
	return createMiddleware(async (c, next) => {
		const actorId = c.get('actorId') as string | undefined
		if (!actorId) return next()

		if (!SAFE_METHODS.has(c.req.method)) {
			// Clear before the write so a read that arrives mid-write is not answered from before it,
			// and again after so a read that re-cached during the write does not outlive it.
			evictListReadsFor(actorId)
			try {
				await next()
			} finally {
				evictListReadsFor(actorId)
			}
			return
		}

		const path = routePathOf(c.req.path)
		// A person reading another member's For You list is authorised inside the handler, per request.
		const readsAnotherActor = path === '/api/for-you' && c.req.query('for_actor_id') !== undefined
		if (c.req.method !== 'GET' || !CACHED_LIST_PATHS.has(path) || readsAnotherActor) return next()

		const workspaceId = c.req.header('X-Workspace-Id') ?? ''
		const search = new URL(c.req.url).search
		const key = listReadCacheKey(actorId, workspaceId, path, search)

		let ranHandler = false
		let snapshot: ListReadSnapshot | null
		try {
			snapshot = await cachedListRead(key, actorId, async () => {
				ranHandler = true
				await next()
				if (c.res.status !== 200) return null
				// Clone so the body stream can still go to the client.
				const body = await c.res.clone().text()
				if (!isCacheableBody(body)) return null
				const headers: Record<string, string> = {}
				for (const name of REPLAYED_HEADERS) {
					const value = c.res.headers.get(name)
					if (value !== null) headers[name] = value
				}
				return { status: 200, body, headers }
			})
		} catch (err) {
			// A failed leader is its own request's problem; a follower just runs the handler itself.
			if (ranHandler) throw err
			return next()
		}

		// The leader's own response is already in c.res.
		if (ranHandler) return
		// The leader's response was not cacheable (error, too big): answer this request on its own.
		if (snapshot === null) return next()
		nameRouteAsHandler(c, path)
		c.res = replay(snapshot)
	})
}
