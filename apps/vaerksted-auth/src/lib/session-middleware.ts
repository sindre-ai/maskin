import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { InvalidSessionTokenError, verifySessionToken } from './session-token'

/**
 * Verifies a vaerksted-auth session token (JWT, `Authorization: Bearer <token>`,
 * signed with VAERKSTED_AUTH_SESSION_JWT_SECRET) and sets `identityId` in
 * context on success — design doc §6 step 2/3 ("authenticated by the session
 * from step 2, the device sends its public key: POST /devices"). Mirrors the
 * *shape* of `packages/auth/src/middleware.ts`'s createMiddleware/c.set
 * pattern without importing it (design doc §4).
 */
export function sessionMiddleware() {
	return createMiddleware<AppEnv>(async (c, next) => {
		const env = c.get('env')
		if (!env.VAERKSTED_AUTH_SESSION_JWT_SECRET) {
			return c.json(
				{ error: 'server_misconfigured', message: 'VAERKSTED_AUTH_SESSION_JWT_SECRET not set' },
				503,
			)
		}

		const authHeader = c.req.header('Authorization')
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json(
				{ error: 'unauthorized', message: 'Missing or invalid Authorization header' },
				401,
			)
		}
		const token = authHeader.slice(7)

		try {
			const payload = await verifySessionToken(token, env.VAERKSTED_AUTH_SESSION_JWT_SECRET)
			c.set('identityId', payload.identityId)
		} catch (err) {
			if (err instanceof InvalidSessionTokenError) {
				return c.json({ error: 'unauthorized', message: 'Invalid or expired session token' }, 401)
			}
			throw err
		}

		return next()
	})
}
