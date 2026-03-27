import { createHmac, timingSafeEqual } from 'node:crypto'

/** Verify HMAC-SHA256 signature with timing-safe comparison */
export function verifyHmacSha256(
	body: string,
	signature: string,
	secret: string,
	prefix?: string,
): boolean {
	const computed = createHmac('sha256', secret).update(body).digest('hex')
	const expected = Buffer.from(prefix ? `${prefix}${computed}` : computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

/** Verify HMAC-SHA1 signature with timing-safe comparison */
export function verifyHmacSha1(
	body: string,
	signature: string,
	secret: string,
	prefix?: string,
): boolean {
	const computed = createHmac('sha1', secret).update(body).digest('hex')
	const expected = Buffer.from(prefix ? `${prefix}${computed}` : computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

export interface TimestampSignatureConfig {
	/** Header containing the request timestamp */
	timestampHeader: string
	/** Header containing the signature */
	signatureHeader: string
	/** Template for the signing base string. Use `{timestamp}` and `{body}` placeholders. */
	bodyTemplate: string
	/** Prefix prepended to the computed HMAC hex digest (e.g. 'v0=') */
	signaturePrefix?: string
	/** Max age in seconds before rejecting (default: 300) */
	maxAgeSeconds?: number
}

/**
 * Verify a timestamp-based HMAC-SHA256 signature.
 * The signing base string is built from the configured template,
 * and the computed digest is compared with timing-safe equality.
 */
export function verifyTimestampSignature(
	body: string,
	headers: Record<string, string>,
	secret: string,
	config: TimestampSignatureConfig,
): boolean {
	const timestamp = headers[config.timestampHeader]
	const signature = headers[config.signatureHeader]
	if (!timestamp || !signature) return false

	// Reject requests older than maxAgeSeconds to prevent replay attacks
	const maxAge = config.maxAgeSeconds ?? 300
	const age = Math.abs(Date.now() / 1000 - Number(timestamp))
	if (age > maxAge) return false

	const baseString = config.bodyTemplate.replace('{timestamp}', timestamp).replace('{body}', body)
	const digest = createHmac('sha256', secret).update(baseString).digest('hex')
	const computed = config.signaturePrefix ? `${config.signaturePrefix}${digest}` : digest

	const expected = Buffer.from(computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}
