import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { deviceCertMiddleware } from './device-cert-middleware'
import { sessionMiddleware } from './session-middleware'

/**
 * Accepts either a session token (Authorization: Bearer <jwt>) or a device
 * cert + challenge signature (X-Device-Cert / X-Nonce / X-Timestamp /
 * X-Signature headers) — used by POST /devices/:id/revoke, which design doc
 * §6 step 5 says should work "from any other linked device" as well as from
 * a logged-in session ("session or device-cert authenticated" per the M2
 * task spec).
 */
export function sessionOrDeviceCertMiddleware() {
	const bySession = sessionMiddleware()
	const byDeviceCert = deviceCertMiddleware()
	return createMiddleware<AppEnv>(async (c, next) => {
		if (c.req.header('Authorization')?.startsWith('Bearer ')) {
			return bySession(c, next)
		}
		if (c.req.header('X-Device-Cert')) {
			return byDeviceCert(c, next)
		}
		return c.json(
			{
				error: 'unauthorized',
				message: 'Provide either a session Authorization header or device-cert headers',
			},
			401,
		)
	})
}
