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

/**
 * Device-generated secret that lets a signed-out phone drop its own registration. The server only
 * keeps its SHA-256, so it is as strong as the client makes it (the Apple app sends 32 random
 * bytes, url-safe).
 */
export const unregisterSecretSchema = z
	.string()
	.min(32)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/, 'unregister_secret must be url-safe')

export const registerDeviceSchema = z.object({
	platform: devicePlatformSchema,
	apns_token: apnsTokenSchema,
	environment: apnsEnvironmentSchema,
	app_version: z.string().min(1).max(64).optional(),
	unregister_secret: unregisterSecretSchema.optional(),
})

export const unregisterDeviceSchema = z.object({
	apns_token: apnsTokenSchema,
	environment: apnsEnvironmentSchema,
	unregister_secret: unregisterSecretSchema,
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
		/** Legacy per-session field: accepted and ignored. The workspace comes from `X-Workspace-Id`. */
		session_id: z.string().uuid().nullish(),
	})
	.superRefine((v, ctx) => {
		if (v.kind === 'push_to_start' && v.session_id) {
			ctx.addIssue({ code: 'custom', path: ['session_id'], message: 'session_id not allowed' })
		}
	})

export const liveActivityTokenResponseSchema = z.object({
	id: z.string().uuid(),
	kind: liveActivityTokenKindSchema,
	device_id: z.string().uuid(),
	workspace_id: z.string().uuid().nullable(),
	updated_at: z.string(),
})

/** One row of the "Agents working" card: the Swift `WorkingAgent` Codable contract. */
export const liveActivityWorkingAgentSchema = z.object({
	id: z.string(),
	sessionId: z.string(),
	name: z.string(),
	doing: z.string(),
	/** Seconds since 2001-01-01T00:00:00Z (Swift's default `Date` Codable encoding). */
	startedAt: z.number(),
	expectedFinishAt: z.number().optional(),
	touchesCustomersOrProduction: z.boolean(),
	objectId: z.string().optional(),
	conversationId: z.string().optional(),
	/** Conversation title. */
	topic: z.string().optional(),
})

/** The ActivityKit `ContentState` of the aggregate activity (`AgentsActivityState`). */
export const liveActivityContentStateSchema = z.object({
	count: z.number().int(),
	finishingSoon: z.number().int(),
	agents: z.array(liveActivityWorkingAgentSchema),
})

export type RegisterLiveActivityTokenInput = z.infer<typeof registerLiveActivityTokenSchema>
export type LiveActivityTokenResponse = z.infer<typeof liveActivityTokenResponseSchema>
export type LiveActivityContentState = z.infer<typeof liveActivityContentStateSchema>

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>
export type UnregisterDeviceInput = z.infer<typeof unregisterDeviceSchema>
export type DeviceResponse = z.infer<typeof deviceResponseSchema>
