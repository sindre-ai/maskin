import { gmailPubsubEnvelopeSchema, gmailPubsubMessageDataSchema } from '@maskin/shared'
import { OAuth2Client } from 'google-auth-library'
import { logger } from '../../../logger'
import type { CustomEventNormalizer } from '../../types'

const oauth2Client = new OAuth2Client()

/**
 * Verify a Pub/Sub push request. Per Google's docs, signature + audience are
 * not enough on their own — any Google-issued ID token with the matching aud
 * would otherwise be accepted. We additionally pin `payload.email` to the
 * service account configured on the Pub/Sub subscription and require
 * `email_verified === true`.
 */
export const gmailWebhookVerifier = async (
	_body: string,
	headers: Record<string, string>,
): Promise<boolean> => {
	const authHeader = headers.authorization
	if (!authHeader?.startsWith('Bearer ')) {
		logger.warn('Gmail webhook missing Bearer token')
		return false
	}

	const idToken = authHeader.slice('Bearer '.length).trim()
	const expectedAudience = process.env.GMAIL_PUBSUB_AUDIENCE
	const expectedServiceAccount = process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT
	if (!expectedAudience) {
		logger.error('GMAIL_PUBSUB_AUDIENCE not configured — cannot verify Gmail push')
		return false
	}
	if (!expectedServiceAccount) {
		logger.error('GMAIL_PUBSUB_SERVICE_ACCOUNT not configured — cannot verify Gmail push')
		return false
	}

	try {
		const ticket = await oauth2Client.verifyIdToken({
			idToken,
			audience: expectedAudience,
		})
		const payload = ticket.getPayload()
		if (!payload) return false
		if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
			logger.warn(`Gmail webhook JWT has unexpected issuer: ${payload.iss}`)
			return false
		}
		if (payload.email_verified !== true) {
			logger.warn('Gmail webhook JWT has unverified email claim')
			return false
		}
		if (payload.email?.toLowerCase() !== expectedServiceAccount.toLowerCase()) {
			logger.warn('Gmail webhook JWT email does not match configured push service account', {
				got: payload.email,
			})
			return false
		}
		return true
	} catch (err) {
		logger.warn('Gmail webhook JWT verification failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

/**
 * Normalize a Gmail Pub/Sub envelope into a placeholder `gmail.history.updated` event.
 *
 * The actual per-message events are produced later by `webhookFanOut`, which calls
 * users.history.list against the previously-stored historyId and emits one event
 * per change (added/labeled/etc.). This split keeps the framework's normalize →
 * lookup-integration flow intact while letting Gmail expand into multiple events.
 */
export const gmailEventNormalizer: CustomEventNormalizer = (payload, _headers) => {
	const envelopeParse = gmailPubsubEnvelopeSchema.safeParse(payload)
	if (!envelopeParse.success) {
		logger.warn('Gmail push envelope failed schema validation', {
			error: envelopeParse.error.message,
		})
		return null
	}

	let decoded: string
	try {
		decoded = Buffer.from(envelopeParse.data.message.data, 'base64').toString('utf8')
	} catch (err) {
		logger.warn('Gmail push message.data is not valid base64', {
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}

	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(decoded)
	} catch {
		logger.warn('Gmail push message.data did not decode to JSON')
		return null
	}

	const dataParse = gmailPubsubMessageDataSchema.safeParse(parsedJson)
	if (!dataParse.success) {
		logger.warn('Gmail push decoded payload failed schema validation', {
			error: dataParse.error.message,
		})
		return null
	}

	return {
		entityType: 'gmail.history',
		action: 'updated',
		installationId: dataParse.data.emailAddress,
		data: {
			historyId: dataParse.data.historyId,
			emailAddress: dataParse.data.emailAddress,
			subscription: envelopeParse.data.subscription,
		},
	}
}
