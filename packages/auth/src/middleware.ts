import type { Database } from '@ai-native/db'
import { createMiddleware } from 'hono/factory'
import { validateApiKey } from './api-keys'

export function authMiddleware(db: Database) {
	return createMiddleware(async (c, next) => {
		const authHeader = c.req.header('Authorization')
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json(
				{
					error: {
						code: 'UNAUTHORIZED',
						message: 'Missing or invalid Authorization header',
						suggestion:
							"Provide a Bearer token in the Authorization header: 'Authorization: Bearer ank_...'",
					},
				},
				401,
			)
		}

		const token = authHeader.slice(7)

		// API key auth
		if (token.startsWith('ank_')) {
			const result = await validateApiKey(db, token)
			if (!result) {
				return c.json(
					{
						error: {
							code: 'UNAUTHORIZED',
							message: 'Invalid API key',
							suggestion: 'Check that your API key is correct and has not been regenerated',
						},
					},
					401,
				)
			}
			c.set('actorId', result.actorId)
			c.set('actorType', result.type)
			return next()
		}

		// Future: Better Auth session validation
		return c.json(
			{
				error: {
					code: 'UNAUTHORIZED',
					message: 'Invalid token format',
					suggestion:
						"API keys must start with 'ank_'. Use POST /api/actors to create an actor and get an API key.",
				},
			},
			401,
		)
	})
}
