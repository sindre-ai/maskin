import { z } from 'zod'

export const devicePlatformSchema = z.enum(['ios', 'macos', 'watchos', 'tvos'])
export const apnsEnvironmentSchema = z.enum(['sandbox', 'production'])

// APNs device tokens are hex strings (32 bytes today, longer allowed by Apple).
// Bounded + charset-restricted at the boundary; the value is later used as a
// URL path segment toward APNs.
export const apnsTokenSchema = z
	.string()
	.min(32)
	.max(512)
	.regex(/^[0-9a-fA-F]+$/, 'APNs token must be a hex string')

export const registerDeviceSchema = z.object({
	platform: devicePlatformSchema,
	apns_token: apnsTokenSchema,
	environment: apnsEnvironmentSchema,
	app_version: z.string().min(1).max(64).optional(),
})

export const deviceResponseSchema = z.object({
	id: z.string().uuid(),
	actor_id: z.string().uuid(),
	platform: devicePlatformSchema,
	environment: apnsEnvironmentSchema,
	app_version: z.string().nullable(),
	created_at: z.string(),
	last_seen_at: z.string(),
})

// ── Live Activity (ActivityKit) tokens ──────────────────────────────────────

export const liveActivityTokenKindSchema = z.enum(['push_to_start', 'update'])

/** ActivityKit tokens are hex like APNs tokens (push-to-start is longer than 32 bytes). */
export const liveActivityTokenSchema = z
	.string()
	.min(16)
	.max(512)
	.regex(/^[0-9a-fA-F]+$/, 'Live Activity token must be a hex string')

export const registerLiveActivityTokenSchema = z
	.object({
		kind: liveActivityTokenKindSchema,
		/** The `id` returned by POST /api/devices — the token's APNs environment comes from that row. */
		device_id: z.string().uuid(),
		token: liveActivityTokenSchema,
		/** Required for `update`, forbidden for `push_to_start`. */
		session_id: z.string().uuid().optional(),
	})
	.superRefine((v, ctx) => {
		if (v.kind === 'update' && !v.session_id) {
			ctx.addIssue({ code: 'custom', path: ['session_id'], message: 'session_id is required' })
		}
		if (v.kind === 'push_to_start' && v.session_id) {
			ctx.addIssue({ code: 'custom', path: ['session_id'], message: 'session_id not allowed' })
		}
	})

export const liveActivityTokenResponseSchema = z.object({
	id: z.string().uuid(),
	kind: liveActivityTokenKindSchema,
	device_id: z.string().uuid(),
	session_id: z.string().uuid().nullable(),
	updated_at: z.string(),
})

/** The ActivityKit `ContentState` pushed for a running turn. Keep it small. */
export const liveActivityContentStateSchema = z.object({
	sessionId: z.string(),
	agentName: z.string(),
	step: z.string(),
	/** Seconds since 2001-01-01T00:00:00Z (Swift's default `Date` Codable encoding). */
	startedAt: z.number(),
	status: z.enum(['running', 'needsYou', 'done', 'failed']),
})

export type RegisterLiveActivityTokenInput = z.infer<typeof registerLiveActivityTokenSchema>
export type LiveActivityTokenResponse = z.infer<typeof liveActivityTokenResponseSchema>
export type LiveActivityContentState = z.infer<typeof liveActivityContentStateSchema>

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>
export type DeviceResponse = z.infer<typeof deviceResponseSchema>
