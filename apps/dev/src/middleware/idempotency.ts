import { createMiddleware } from 'hono/factory'

interface CachedResponse {
	status: number
	body: unknown
	timestamp: number
}

const TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const cache = new Map<string, CachedResponse>()

// Periodically clean expired entries
setInterval(
	() => {
		const now = Date.now()
		for (const [key, entry] of cache) {
			if (now - entry.timestamp > TTL_MS) cache.delete(key)
		}
	},
	60 * 60 * 1000,
) // Every hour

export const idempotencyMiddleware = createMiddleware(async (c, next) => {
	const method = c.req.method
	if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
		return next()
	}

	const idempotencyKey = c.req.header('Idempotency-Key')
	if (!idempotencyKey) {
		return next()
	}

	const actorId = c.get('actorId') as string | undefined
	const cacheKey = `${actorId ?? 'anon'}:${idempotencyKey}`

	const cached = cache.get(cacheKey)
	if (cached) {
		return c.json(cached.body as Record<string, unknown>, cached.status as 200)
	}

	await next()

	// Cache the response
	if (c.res.headers.get('content-type')?.includes('application/json')) {
		const cloned = c.res.clone()
		const body = await cloned.json()
		cache.set(cacheKey, {
			status: cloned.status,
			body,
			timestamp: Date.now(),
		})
	}
})
