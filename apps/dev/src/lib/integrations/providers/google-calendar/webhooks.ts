import { createHmac, timingSafeEqual } from 'node:crypto'
import { logger } from '../../../logger'
import type { CustomEventNormalizer } from '../../types'

/**
 * Channel-token format we send to Google when creating a watch:
 *   `${email}:${hex(hmac-sha256(email, GOOGLE_CALENDAR_WEBHOOK_SECRET))}`
 *
 * Google echoes this token back in `X-Goog-Channel-Token` on every push. We
 * verify the HMAC here so an attacker who knows our webhook URL can't spoof a
 * push for another user (which would otherwise cause us to call events.list
 * against the victim's stored sync token and write events into their workspace).
 *
 * Returns the email on success so the normalizer can use it as the
 * `installationId` (= externalId on the integrations row).
 */
export function buildChannelToken(email: string, secret: string): string {
	const mac = createHmac('sha256', secret).update(email).digest('hex')
	return `${email}:${mac}`
}

function parseAndVerifyChannelToken(token: string, secret: string): string | null {
	const sep = token.lastIndexOf(':')
	if (sep <= 0 || sep >= token.length - 1) return null
	const email = token.slice(0, sep)
	const providedMac = token.slice(sep + 1)
	const expectedMac = createHmac('sha256', secret).update(email).digest('hex')
	if (providedMac.length !== expectedMac.length) return null
	try {
		const ok = timingSafeEqual(Buffer.from(providedMac, 'hex'), Buffer.from(expectedMac, 'hex'))
		return ok ? email : null
	} catch {
		// Non-hex provided mac etc.
		return null
	}
}

/**
 * Verify a Google Calendar push.
 *
 * Google's push delivery does not sign the body — channel verification is via
 * the token we set at `events.watch` time, which Google echoes back in
 * `X-Goog-Channel-Token`. Our token is HMAC'd, so possession of the webhook
 * URL alone isn't enough to forge a push for another integration.
 *
 * The body is typically empty (Calendar push is pointer-style). We don't
 * validate it here; fan-out reads the sync token from the integration row and
 * calls events.list to fetch the actual changes.
 */
export const googleCalendarWebhookVerifier = (
	_body: string,
	headers: Record<string, string>,
): boolean => {
	const secret = process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET
	if (!secret) {
		logger.error(
			'GOOGLE_CALENDAR_WEBHOOK_SECRET not configured — cannot verify Google Calendar push',
		)
		return false
	}

	const token = headers['x-goog-channel-token']
	if (!token) {
		logger.warn('Google Calendar push missing X-Goog-Channel-Token')
		return false
	}

	const email = parseAndVerifyChannelToken(token, secret)
	if (!email) {
		logger.warn('Google Calendar push channel token failed HMAC verification')
		return false
	}

	return true
}

/**
 * Normalize a Google Calendar push into a placeholder `google-calendar.events.changed`
 * event. The actual per-event changes are produced later by webhookFanOut, which
 * calls events.list using the stored syncToken and emits one event per change.
 *
 * Required headers (set by Google on every push):
 *   - x-goog-channel-id        — our channel UUID
 *   - x-goog-channel-token     — `${email}:${hmac}`, verified above
 *   - x-goog-resource-id       — Google's opaque resource id
 *   - x-goog-resource-state    — `sync` | `exists` | `not_exists`
 *
 * `sync` arrives once right after channel creation. We acknowledge but emit no
 * fan-out event — there's nothing to list yet.
 */
export const googleCalendarEventNormalizer: CustomEventNormalizer = (_payload, headers) => {
	const secret = process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET
	if (!secret) return null

	const token = headers['x-goog-channel-token']
	const channelId = headers['x-goog-channel-id']
	const resourceId = headers['x-goog-resource-id']
	const resourceState = headers['x-goog-resource-state']
	if (!token || !channelId || !resourceId || !resourceState) {
		logger.warn('Google Calendar push missing required X-Goog-* headers')
		return null
	}

	const email = parseAndVerifyChannelToken(token, secret)
	if (!email) return null

	if (resourceState === 'sync') {
		// Channel handshake — no event to emit; the webhook route will ack with 200.
		return null
	}

	return {
		entityType: 'google-calendar.channel',
		action: 'notified',
		installationId: email,
		data: {
			channelId,
			resourceId,
			resourceState,
		},
	}
}
