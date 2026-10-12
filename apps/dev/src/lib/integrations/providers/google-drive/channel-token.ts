import { createHmac, timingSafeEqual } from 'node:crypto'

export const CHANNEL_TOKEN_SECRET_ENV = 'GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET'

/**
 * The token we hand Google at changes.watch and that Google echoes back in
 * X-Goog-Channel-Token on every delivery: HMAC-SHA256(secret, channel id), hex.
 * Drive does not sign the payload, so this is the only proof a delivery is ours.
 * Throws when the secret is unset so a misconfigured deploy fails at channel
 * creation instead of minting channels no delivery can ever verify against.
 */
export function computeChannelToken(channelId: string): string {
	const secret = process.env[CHANNEL_TOKEN_SECRET_ENV]
	if (!secret) throw new Error(`${CHANNEL_TOKEN_SECRET_ENV} env var is required for google-drive`)
	return createHmac('sha256', secret).update(channelId).digest('hex')
}

/**
 * Constant-time check of a delivery's token against the HMAC of its channel id.
 * Fails closed when the secret is unset or the lengths differ.
 */
export function verifyChannelToken(channelId: string, token: string): boolean {
	if (!process.env[CHANNEL_TOKEN_SECRET_ENV]) return false
	const expected = Buffer.from(computeChannelToken(channelId))
	const got = Buffer.from(token)
	if (expected.length !== got.length) return false
	return timingSafeEqual(expected, got)
}
