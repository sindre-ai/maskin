import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { OAuth2Client } from 'google-auth-library'
import { logger } from '../../../logger'
import type {
	CustomEventNormalizer,
	NormalizedEvent,
	ResolveInstallationIdContext,
} from '../../types'

const oauth2Client = new OAuth2Client()

/**
 * Verify a Pub/Sub push OIDC token. Copy of gmailWebhookVerifier — swap the
 * env-var names + pin the audience/service-account to google-meet's Pub/Sub
 * push subscription. Rejects anything that doesn't match, byte-for-byte.
 */
export const meetWebhookVerifier = async (
	_body: string,
	headers: Record<string, string>,
): Promise<boolean> => {
	const authHeader = headers.authorization
	if (!authHeader?.startsWith('Bearer ')) {
		logger.warn('Google Meet webhook missing Bearer token')
		return false
	}
	const idToken = authHeader.slice('Bearer '.length).trim()
	const expectedAudience = process.env.GOOGLE_MEET_PUBSUB_AUDIENCE
	const expectedServiceAccount = process.env.GOOGLE_MEET_PUBSUB_SERVICE_ACCOUNT
	if (!expectedAudience) {
		logger.error('GOOGLE_MEET_PUBSUB_AUDIENCE not configured — cannot verify Meet push')
		return false
	}
	if (!expectedServiceAccount) {
		logger.error('GOOGLE_MEET_PUBSUB_SERVICE_ACCOUNT not configured — cannot verify Meet push')
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
			logger.warn(`Meet webhook JWT has unexpected issuer: ${payload.iss}`)
			return false
		}
		if (payload.email_verified !== true) {
			logger.warn('Meet webhook JWT has unverified email claim')
			return false
		}
		if (payload.email?.toLowerCase() !== expectedServiceAccount.toLowerCase()) {
			logger.warn('Meet webhook JWT email does not match configured push service account', {
				got: payload.email,
			})
			return false
		}
		return true
	} catch (err) {
		logger.warn('Meet webhook JWT verification failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

interface PubsubEnvelope {
	message: {
		data: string
		messageId: string
		attributes?: Record<string, string>
	}
	subscription?: string
}

function parsePubsubEnvelope(payload: unknown): PubsubEnvelope | null {
	if (typeof payload !== 'object' || payload === null) return null
	const p = payload as Record<string, unknown>
	const message = p.message as Record<string, unknown> | undefined
	if (!message) return null
	const data = message.data
	const messageId = message.messageId
	if (typeof data !== 'string' || typeof messageId !== 'string') return null
	return {
		message: {
			data,
			messageId,
			attributes: message.attributes as Record<string, string> | undefined,
		},
		subscription: typeof p.subscription === 'string' ? p.subscription : undefined,
	}
}

interface MeetEventData {
	eventType?: string
	// Workspace Events with includeResource=false delivers a reference:
	// { resource: { name: '//cloudidentity.googleapis.com/users/<peopleId>' } }
	// or the event-specific resource ref (spaces/*, conferenceRecords/*, ...)
	resource?: { name?: string }
	// Some payload variants use nested keys.
	conferenceRecord?: string
	space?: string
}

/**
 * Extract a Google People-id from the delivered Workspace Events payload.
 * Falls back to the Pub/Sub attribute if present.
 */
export function extractPeopleId(data: MeetEventData, attrs?: Record<string, string>): string | null {
	const refName = data.resource?.name
	if (typeof refName === 'string') {
		const m = refName.match(/\/users\/([^/]+)$/)
		if (m?.[1]) return m[1]
	}
	if (attrs?.userId) return attrs.userId
	if (attrs?.peopleId) return attrs.peopleId
	return null
}

/**
 * Normalize a Meet Pub/Sub push into a placeholder event. The generic route
 * then calls resolveInstallationId (below) to swap the People-id for the
 * matching row's external_id, and webhookFanOut takes it from there.
 */
export const meetEventNormalizer: CustomEventNormalizer = (payload, _headers) => {
	const envelope = parsePubsubEnvelope(payload)
	if (!envelope) {
		logger.warn('Meet push envelope failed schema validation')
		return null
	}
	let decoded: string
	try {
		decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8')
	} catch (err) {
		logger.warn('Meet push message.data is not valid base64', {
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(decoded)
	} catch {
		logger.warn('Meet push message.data did not decode to JSON')
		return null
	}
	const data = parsed as MeetEventData
	const peopleId = extractPeopleId(data, envelope.message.attributes)
	if (!peopleId) {
		logger.warn('Meet push carries no People-id; cannot route to workspace')
		return null
	}
	const eventType = typeof data.eventType === 'string' ? data.eventType : 'unknown'
	// Placeholder installationId = peopleId; resolveInstallationId swaps it
	// for the row's external_id before the WHERE lookup.
	return {
		entityType: 'google_meet.push',
		action: eventTypeToAction(eventType),
		installationId: peopleId,
		data: {
			eventType,
			resourceName: data.resource?.name,
			conferenceRecordName: data.conferenceRecord,
			spaceName: data.space,
			messageId: envelope.message.messageId,
			peopleId,
		},
	}
}

function eventTypeToAction(eventType: string): string {
	if (eventType.endsWith('conference.v2.ended')) return 'conference_ended'
	if (eventType.endsWith('transcript.v2.fileGenerated')) return 'transcript_ready'
	if (eventType.endsWith('recording.v2.fileGenerated')) return 'recording_ready'
	return 'other'
}

/**
 * Look the People-id up against integrations.config.meet.peopleId and return
 * the row's external_id (host Google email) — the value the generic route
 * matches against `integrations.external_id`.
 *
 * We do the join here (post-normalize, pre-lookup) rather than in the
 * normalizer because normalizers are sync + payload-only.
 */
export async function resolveMeetInstallationId(
	ctx: ResolveInstallationIdContext,
): Promise<string | null> {
	const db = ctx.db as Database
	const peopleId = ctx.normalized.installationId
	if (!peopleId) return null
	const rows = await db
		.select({ externalId: integrations.externalId })
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'google-meet'),
				eq(integrations.status, 'active'),
				sql`${integrations.config}->'meet'->>'peopleId' = ${peopleId}`,
			),
		)
		.limit(1)
	const row = rows[0]
	return row?.externalId ?? null
}

/**
 * Pub/Sub message.messageId is the delivery dedup key. The webhook_deliveries
 * ledger stores one row per (provider, messageId, workspaceId) so a Pub/Sub
 * retry lands as a duplicate and is short-circuited.
 */
export function extractMeetDeliveryId(payload: unknown): string | null {
	const envelope = parsePubsubEnvelope(payload)
	return envelope?.message.messageId ?? null
}

// Small re-export for tests that need to look at the raw normalized shape.
export type { NormalizedEvent }
