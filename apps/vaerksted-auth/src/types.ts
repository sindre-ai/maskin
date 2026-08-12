import type { Database } from './db/connection'
import type { VaerkstedAuthEnv } from './lib/env'

/**
 * Shared Hono context shape. Mirrors the shape of `packages/auth/src/middleware.ts`'s
 * `createMiddleware` + `c.set(...)` pattern (per the M2 task's read-only
 * reference to that file) — NOT an import of it, since this app must have
 * zero code-level dependency on Maskin internals (design doc §4).
 */
export type AppEnv = {
	Variables: {
		db: Database
		env: VaerkstedAuthEnv
		// Set by session-middleware.ts on a valid session token.
		identityId?: string
		// Set by device-cert-middleware.ts on a valid device cert + challenge signature.
		deviceId?: string
	}
}
