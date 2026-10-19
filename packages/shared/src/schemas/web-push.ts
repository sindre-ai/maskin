import { z } from 'zod'

// A push endpoint is an https URL minted by the browser vendor's push service. It is later the
// target of an outbound request, so it is bounded and https-only at the boundary.
export const webPushEndpointSchema = z
	.string()
	.max(2048)
	.url()
	.refine((u) => u.startsWith('https://'), 'Push endpoint must be https')

// Base64url-encoded key material from PushSubscription.toJSON().keys.
const base64UrlSchema = z
	.string()
	.min(8)
	.max(256)
	.regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Must be base64url')

export const registerWebPushSubscriptionSchema = z.object({
	endpoint: webPushEndpointSchema,
	keys: z.object({
		p256dh: base64UrlSchema,
		auth: base64UrlSchema,
	}),
	user_agent: z.string().max(512).optional(),
})

export const webPushSubscriptionResponseSchema = z.object({
	id: z.string().uuid(),
	actor_id: z.string().uuid(),
	user_agent: z.string().nullable(),
	created_at: z.string(),
	last_seen_at: z.string(),
})

export const webPushConfigResponseSchema = z.object({
	enabled: z.boolean(),
	// Public by design (it is the VAPID application server key); null when push is not configured.
	public_key: z.string().nullable(),
})
