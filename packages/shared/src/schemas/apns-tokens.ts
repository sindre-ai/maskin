import { z } from 'zod'

// APNs environment split — matches the `aps-environment` entitlement Xcode
// stamps on the build. Debug and TestFlight/Ad-Hoc use the sandbox APNs
// server; App Store builds use production. The client sends whichever the
// shell was built against so the server-side sender can hit the matching
// APNs environment.
export const apnsEnvironmentSchema = z.enum(['sandbox', 'production'])

// Hex-encoded APNs device token. Apple's docs describe device tokens as
// opaque byte strings; the current wire format is 64 hex chars (32 bytes),
// but Apple has flagged this may grow. The bound below keeps the payload
// small while comfortably accommodating any realistic future expansion.
// Case is normalised to lower-case at the boundary so an upsert on
// `token` doesn't split rows on hex-casing.
const APNS_TOKEN_MIN = 32
const APNS_TOKEN_MAX = 400

export const apnsTokenValueSchema = z
	.string()
	.min(APNS_TOKEN_MIN)
	.max(APNS_TOKEN_MAX)
	.regex(/^[0-9a-fA-F]+$/, 'APNs token must be hex-encoded')
	.transform((v) => v.toLowerCase())

export const registerApnsTokenBodySchema = z.object({
	token: apnsTokenValueSchema,
	environment: apnsEnvironmentSchema,
})

export const apnsTokenResponseSchema = z.object({
	id: z.string().uuid(),
	token: z.string(),
	environment: apnsEnvironmentSchema,
	created_at: z.string(),
	updated_at: z.string(),
})

export type RegisterApnsTokenBody = z.infer<typeof registerApnsTokenBodySchema>
export type ApnsEnvironment = z.infer<typeof apnsEnvironmentSchema>
