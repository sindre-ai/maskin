import { z } from 'zod'

// Only VAERKSTED_SYNC_DATABASE_URL and VAERKSTED_AUTH_SIGNING_PUBLIC_KEY are
// required for this service to do anything at all: it needs its own DB to
// read/write sync_blob rows, and it needs vaerksted-auth's CA public key to
// verify device certs locally (design doc §9: "it authenticates callers via
// device certs from vaerksted-auth — it does not run its own login flow" —
// no network call back to vaerksted-auth per request). Both are still parsed
// as optional here (mirroring apps/vaerksted-auth/src/lib/env.ts) so the
// process still starts for health checks even if misconfigured; routes/
// middleware that need them check presence themselves and return a clear
// error response instead of crashing.
const envSchema = z.object({
	// Deliberately distinct from apps/dev's 3000 and apps/vaerksted-auth's
	// 3001 — all three may run side-by-side in local dev and in the same
	// Docker Compose stack (see docker-compose.prod.yml, where none publish a
	// host port and Traefik/Coolify routes by domain instead).
	PORT: z
		.string()
		.optional()
		.default('3002')
		.transform((v) => {
			const n = Number(v)
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid PORT: ${v}`)
			}
			return n
		}),
	VAERKSTED_SYNC_DATABASE_URL: z
		.string()
		.min(1, 'VAERKSTED_SYNC_DATABASE_URL is required — vaerksted-sync has its own Postgres schema'),
	// Reused, not duplicated: the same CA public key vaerksted-auth already
	// exposes to verifiers (design doc §6 step 3/4). vaerksted-sync verifies
	// device certs signed by vaerksted-auth's signing key locally — it never
	// needs the corresponding private key.
	VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: z.string().optional(),
})

export type VaerkstedSyncEnv = z.infer<typeof envSchema>

export function parseEnv(): VaerkstedSyncEnv {
	return envSchema.parse(process.env)
}
