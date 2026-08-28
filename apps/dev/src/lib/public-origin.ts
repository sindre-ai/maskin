/**
 * The origin an external service should be told to call us back on.
 *
 * `CORS_ORIGIN` wins when set, and that is the security-relevant part: without
 * it a caller could inject `X-Forwarded-Host` and redirect an OAuth callback —
 * and the credential it carries — at a host of their choosing. The forwarded
 * headers are a local-development fallback only.
 *
 * Extracted from `routes/integrations.ts` so the tool-broker OAuth flow uses the
 * same rule rather than a second copy that could drift from it.
 */
export function resolvePublicOrigin(
	requestUrl: string,
	headers: Record<string, string | undefined>,
): string {
	const corsOrigin = process.env.CORS_ORIGIN
	if (corsOrigin) {
		return (corsOrigin.split(',')[0] ?? corsOrigin).trim().replace(/\/$/, '')
	}

	const forwardedHost = headers['x-forwarded-host']
	const forwardedProto = headers['x-forwarded-proto']

	if (forwardedHost) {
		const proto = forwardedProto ?? 'https'
		return `${proto}://${forwardedHost}`
	}

	return new URL(requestUrl).origin
}
