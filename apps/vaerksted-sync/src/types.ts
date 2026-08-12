import type { Database } from './db/connection'
import type { VaerkstedSyncEnv } from './lib/env'

/**
 * Shared Hono context shape. Mirrors `apps/vaerksted-auth/src/types.ts`'s
 * shape (itself mirroring `packages/auth/src/middleware.ts`'s
 * createMiddleware + c.set(...) pattern) — NOT an import of either, since
 * this app must have zero code-level dependency on Maskin or vaerksted-auth
 * internals (design doc §4).
 */
export type AppEnv = {
	Variables: {
		db: Database
		env: VaerkstedSyncEnv
		// Set by device-cert-middleware.ts on a valid device cert + challenge
		// signature. vaerksted-sync has no session concept of its own (§9: "it
		// does not run its own login flow") — every authenticated route is
		// device-cert authenticated.
		deviceId: string
		identityId: string
	}
}
