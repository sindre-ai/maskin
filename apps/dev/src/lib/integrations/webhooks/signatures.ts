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

/**
 * Verify Slack-style timestamp-based signature.
 * Slack signs `v0:${timestamp}:${body}` with HMAC-SHA256
 * and sends signature in `x-slack-signature` header.
 */
export function verifyTimestampSignature(
	body: string,
	headers: Record<string, string>,
	secret: string,
): boolean {
	const timestamp = headers['x-slack-request-timestamp']
	const signature = headers['x-slack-signature']
	if (!timestamp || !signature) return false

	// Reject requests older than 5 minutes to prevent replay attacks
	const age = Math.abs(Date.now() / 1000 - Number(timestamp))
	if (age > 300) return false

	const baseString = `v0:${timestamp}:${body}`
	const computed = `v0=${createHmac('sha256', secret).update(baseString).digest('hex')}`

	const expected = Buffer.from(computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}
