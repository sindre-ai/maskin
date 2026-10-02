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

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>
export type DeviceResponse = z.infer<typeof deviceResponseSchema>
