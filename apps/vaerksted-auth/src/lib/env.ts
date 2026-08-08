import { z } from 'zod'

// Only VAERKSTED_AUTH_DATABASE_URL is required at boot — without a database
// this service can do nothing at all. Supabase credentials and the CA
// signing/session-JWT secrets are parsed as optional here so the process
// still starts (health checks, etc. work) even if they're unset; individual
// routes/middleware that need them check presence themselves and return a
// clear error response instead of crashing — see `supabase.ts`,
// `session-middleware.ts`, `device-cert-middleware.ts`.
const envSchema = z.object({
	// Deliberately distinct from apps/dev's 3000 — both may run side-by-side
	// in local dev and in the same Docker Compose stack (see
	// docker-compose.prod.yml, where neither publishes a host port and
	// Traefik/Coolify routes by domain instead).
	PORT: z
		.string()
		.optional()
		.default('3001')
		.transform((v) => {
			const n = Number(v)
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid PORT: ${v}`)
			}
			return n
		}),
	VAERKSTED_AUTH_DATABASE_URL: z
		.string()
		.min(1, 'VAERKSTED_AUTH_DATABASE_URL is required — vaerksted-auth has its own Postgres schema'),
	// Supabase Auth (GoTrue) admin client credentials — design doc §6a. A
	// dedicated Supabase project for vaerksted-auth, not Maskin's own.
	SUPABASE_URL: z.string().optional(),
	SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
	// Ed25519 keypair (hex-encoded, see @maskin/vaerksted-crypto) vaerksted-auth
	// uses as its own signing ("CA") key for device certs — design doc §6
	// step 3. Private key signs, public key is handed to verifiers (including
	// this service's own device-cert-middleware).
	VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: z.string().optional(),
	VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: z.string().optional(),
	// HMAC secret for session JWTs minted by POST /identities and POST /sessions.
	VAERKSTED_AUTH_SESSION_JWT_SECRET: z.string().optional(),
})

export type VaerkstedAuthEnv = z.infer<typeof envSchema>

export function parseEnv(): VaerkstedAuthEnv {
	return envSchema.parse(process.env)
}
