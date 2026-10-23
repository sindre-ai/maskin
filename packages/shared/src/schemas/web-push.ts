import { z } from 'zod'

// Hosts the browsers' push services run on. The server POSTs to a stored endpoint, so an
// endpoint must be one of these: an https-only check would let any signed-in user aim the
// server at internal hosts (SSRF). An allowlist, not an IP blocklist, because blocklists lose to
// DNS rebinding and alternate IP encodings.
const PUSH_SERVICE_HOSTS = [
	'fcm.googleapis.com', // Chrome, Edge, Brave, Opera
	'push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com and regional)
	'push.apple.com', // Safari (web.push.apple.com)
	'notify.windows.com', // Edge on Windows (*.notify.windows.com)
]

/** True only for an https URL on a known push service, default port, no credentials. */
export function isAllowedWebPushEndpoint(endpoint: string): boolean {
	let url: URL
	try {
		url = new URL(endpoint)
	} catch {
		return false
	}
	if (url.protocol !== 'https:' || url.username || url.password) return false
	if (url.port && url.port !== '443') return false
	const host = url.hostname.toLowerCase()
	return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

// A push endpoint is a URL minted by the browser vendor's push service. It is later the target
// of an outbound request, so it is bounded and restricted to known push services at the boundary.
export const webPushEndpointSchema = z
	.string()
	.max(2048)
	.url()
	.refine(isAllowedWebPushEndpoint, 'Push endpoint must be on a known browser push service')

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
