import type { Database } from '@ai-native/db'
import { createMiddleware } from 'hono/factory'
import { validateApiKey } from './api-keys'

export function authMiddleware(db: Database) {
	return createMiddleware(async (c, next) => {
		const authHeader = c.req.header('Authorization')
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json({ error: 'Missing or invalid Authorization header' }, 401)
		}

		const token = authHeader.slice(7)

		// API key auth
		if (token.startsWith('ank_')) {
			const result = await validateApiKey(db, token)
			if (!result) {
				return c.json({ error: 'Invalid API key' }, 401)
			}
			c.set('actorId', result.actorId)
			c.set('actorType', result.type)
			return next()
		}

		// Future: Better Auth session validation
		return c.json({ error: 'Invalid token format' }, 401)
	})
}
