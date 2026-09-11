import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import type {
	NormalizedEvent,
	PostInstallContext,
	PreDisconnectContext,
	StoredCredentials,
	WebhookFanOutContext,
} from '../../types'
import { callGoogleApi } from './client'
import { classifyGoogleApiError, MeetToolError } from './errors'
import {
	attachTranscriptFile,
	ensureMeetMeetingFields,
	writeMeetingMetadata,
} from './meeting-metadata'

/**
 * Stored under integrations.config alongside system_actor_id.
 *
 * `peopleId` is set at OAuth callback (Task 2 territory) — the People API
 * `metadata.sources[0].id`; the join key webhookPreHandler uses to route
 * deliveries from a shared Pub/Sub topic to this workspace's row.
 *
 * `subscriptionName`, `subscriptionExpiresAt`, `subscriptionTargetResource`
 * are written by `setupMeetWatch` on install (or the renewer on refresh).
 */
export interface MeetIntegrationConfig extends IntegrationConfig {
	meet?: {
		peopleId?: string
		subscriptionName?: string
		subscriptionExpiresAt?: number
		subscriptionTargetResource?: string
	}
}

const WORKSPACE_EVENTS_BASE = 'https://workspaceevents.googleapis.com/v1/subscriptions'
const MEET_EVENT_TYPES = [
	'google.workspace.meet.conference.v2.ended',
	'google.workspace.meet.recording.v2.fileGenerated',
	'google.workspace.meet.transcript.v2.fileGenerated',
] as const

function requiredEnv(name: string): string {
	const val = process.env[name]
	if (!val) throw new Error(`${name} env var is required for google-meet`)
	return val
}

interface WorkspaceEventsSubscription {
	name: string
	targetResource: string
	eventTypes: string[]
	expireTime?: string
	uid?: string
}

async function createSubscription(
	accessToken: string,
	peopleId: string,
	topic: string,
): Promise<WorkspaceEventsSubscription> {
	const body = {
		targetResource: `//cloudidentity.googleapis.com/users/${peopleId}`,
		eventTypes: MEET_EVENT_TYPES,
		notificationEndpoint: { pubsubTopic: topic },
		payloadOptions: { includeResource: false },
		ttl: '604800s',
	}
	// Workspace Events uses a POST with no wait — returns the subscription
	// resource inline. If Google surfaces a validation error we hand it back as
	// a normalized MeetToolError so callers upstream can log a stable code.
	return callGoogleApi<WorkspaceEventsSubscription>(WORKSPACE_EVENTS_BASE, accessToken, {
		method: 'POST',
		body,
	})
}

async function reactivateOrRecreate(
	accessToken: string,
	subscriptionName: string,
	peopleId: string,
	topic: string,
): Promise<WorkspaceEventsSubscription> {
	// Meet subscriptions:reactivate availability drifted historically; probe first,
	// fall back to delete + recreate on 404 / METHOD_NOT_ALLOWED.
	try {
		return await callGoogleApi<WorkspaceEventsSubscription>(
			`https://workspaceevents.googleapis.com/v1/${subscriptionName}:reactivate`,
			accessToken,
			{ method: 'POST', body: {} },
		)
	} catch (err) {
		if (
			err instanceof MeetToolError &&
			(err.envelope.error.provider_status === 404 ||
				err.envelope.error.provider_status === 405 ||
				err.envelope.error.provider_status === 400)
		) {
			logger.info('Meet reactivate not available; deleting and recreating subscription', {
				subscriptionName,
			})
			try {
				await callGoogleApi<unknown>(
					`https://workspaceevents.googleapis.com/v1/${subscriptionName}`,
					accessToken,
					{ method: 'DELETE' },
				)
			} catch (delErr) {
				if (!(delErr instanceof MeetToolError && delErr.envelope.error.provider_status === 404)) {
					throw delErr
				}
			}
			return createSubscription(accessToken, peopleId, topic)
		}
		throw err
	}
}

function parseExpireTime(iso: string | undefined): number {
	if (!iso) return Date.now() + 6 * 24 * 60 * 60 * 1000
	const t = Date.parse(iso)
	return Number.isFinite(t) && t > 0 ? t : Date.now() + 6 * 24 * 60 * 60 * 1000
}

/**
 * postInstall hook — creates the Workspace Events subscription so Meet event
 * pushes for this host land on the shared Pub/Sub topic. Persists the
 * subscription's name/expireTime/targetResource on config.meet.
 */
export async function setupMeetWatch(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	const topic = requiredEnv('GOOGLE_MEET_PUBSUB_TOPIC')
	const accessToken = ctx.credentials.accessToken
	if (!accessToken) throw new Error('Google Meet postInstall: no access token in credentials')

	const [row] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	if (!row) throw new Error(`Integration ${ctx.integrationId} not found`)
	const cfg = (row.config as MeetIntegrationConfig | null) ?? {}
	const peopleId = cfg.meet?.peopleId
	if (!peopleId) {
		// Task 2 territory: the People-id is fetched at OAuth callback. If Task 2
		// hasn't landed and the config doesn't carry it, we can't build the
		// user-scoped targetResource — skip loudly.
		logger.warn(
			'setupMeetWatch skipped: config.meet.peopleId missing (Task 2 OAuth callback not run yet)',
			{ integrationId: ctx.integrationId },
		)
		return
	}

	const subscription = await createSubscription(accessToken, peopleId, topic)
	const expiresAt = parseExpireTime(subscription.expireTime)
	const meetSubobject = JSON.stringify({
		peopleId,
		subscriptionName: subscription.name,
		subscriptionExpiresAt: expiresAt,
		subscriptionTargetResource: subscription.targetResource,
	})
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{meet}', ${meetSubobject}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, ctx.integrationId))
	logger.info('Meet Workspace Events subscription registered', {
		integrationId: ctx.integrationId,
		subscriptionName: subscription.name,
		expiresAt,
	})
}

export async function renewMeetWatch(db: Database, integrationId: string): Promise<void> {
	const [row] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, integrationId))
		.limit(1)
	if (!row) throw new Error(`Integration ${integrationId} not found`)
	const cfg = (row.config as MeetIntegrationConfig | null) ?? {}
	const peopleId = cfg.meet?.peopleId
	if (!peopleId) {
		logger.warn('renewMeetWatch skipped: config.meet.peopleId missing', { integrationId })
		return
	}
	const topic = requiredEnv('GOOGLE_MEET_PUBSUB_TOPIC')

	const provider = getProvider(row.provider)
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, integrationId, provider)

	const existingName = cfg.meet?.subscriptionName
	const subscription = existingName
		? await reactivateOrRecreate(accessToken, existingName, peopleId, topic)
		: await createSubscription(accessToken, peopleId, topic)
	const expiresAt = parseExpireTime(subscription.expireTime)
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(
				jsonb_set(
					COALESCE(${integrations.config}, '{}'::jsonb),
					'{meet,subscriptionName}',
					to_jsonb(${subscription.name}::text),
					true
				),
				'{meet,subscriptionExpiresAt}',
				to_jsonb(${expiresAt}::bigint),
				true
			)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, integrationId))
	logger.info('Meet subscription renewed', {
		integrationId,
		subscriptionName: subscription.name,
		expiresAt,
	})
}

export async function stopMeetWatch(ctx: PreDisconnectContext): Promise<void> {
	const db = ctx.db as Database
	const accessToken = ctx.credentials.accessToken
	const [row] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	const cfg = (row?.config as MeetIntegrationConfig | null) ?? {}
	const subscriptionName = cfg.meet?.subscriptionName
	if (subscriptionName && accessToken) {
		try {
			await callGoogleApi<unknown>(
				`https://workspaceevents.googleapis.com/v1/${subscriptionName}`,
				accessToken,
				{ method: 'DELETE' },
			)
			logger.info('Meet subscription deleted', {
				integrationId: ctx.integrationId,
				subscriptionName,
			})
		} catch (err) {
			// 404 = already gone; any other failure is best-effort logged.
			if (!(err instanceof MeetToolError && err.envelope.error.provider_status === 404)) {
				logger.warn('Meet subscription delete failed (continuing with disconnect)', {
					integrationId: ctx.integrationId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}
	// Clear the meet subobject from config so a re-connect starts fresh.
	if (row) {
		await db
			.update(integrations)
			.set({
				config: sql`(${integrations.config} - 'meet')`,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, ctx.integrationId))
	}
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

interface MeetTranscript {
	name: string
	state?: string
	startTime?: string
	endTime?: string
}

interface MeetTranscriptEntry {
	name: string
	participant?: string
	text?: string
	languageCode?: string
	startTime?: string
	endTime?: string
}

interface MeetRecording {
	name: string
	state?: string
	startTime?: string
	endTime?: string
	driveDestination?: { file?: string; exportUri?: string }
}

interface MeetConferenceRecord {
	name: string
	space?: string
	startTime?: string
	endTime?: string
}

interface MeetParticipant {
	name: string
	earliestStartTime?: string
	latestEndTime?: string
	signedInUser?: { user?: string; displayName?: string }
	anonymousUser?: { displayName?: string }
	phoneUser?: { displayName?: string }
}

const MEET_API_BASE = 'https://meet.googleapis.com/v2'

async function fetchPages<TItem>(
	url: string,
	accessToken: string,
	itemKey: string,
	maxPages = 20,
): Promise<TItem[]> {
	const out: TItem[] = []
	let pageToken: string | undefined
	for (let i = 0; i < maxPages; i++) {
		const page = await callGoogleApi<Record<string, unknown>>(url, accessToken, {
			query: pageToken ? { pageToken } : undefined,
		})
		const items = (page[itemKey] as TItem[] | undefined) ?? []
		out.push(...items)
		const next = page.nextPageToken
		if (typeof next !== 'string' || next.length === 0) return out
		pageToken = next
	}
	logger.warn('Meet fetchPages pagination exceeded safety bound', { url })
	return out
}

interface FanOutPayload {
	eventType: string
	resourceName?: string
	spaceName?: string
	conferenceRecordName?: string
}

/**
 * Decode the base64 message.data body into { eventType, resource-refs }.
 * With payloadOptions.includeResource=false the delivered payload carries the
 * event type and a resource reference; we fetch full artefacts under the
 * host's token below.
 */
export function parseMeetFanOutPayload(
	messageData: Record<string, unknown>,
): FanOutPayload | null {
	const eventType = typeof messageData.eventType === 'string' ? messageData.eventType : undefined
	if (!eventType) return null
	const resource = messageData.resource as Record<string, unknown> | undefined
	// Workspace Events (includeResource=false) delivers { eventType, resource: { name } }
	// or a similar reference; we tolerate both shapes.
	const resourceName =
		typeof resource?.name === 'string'
			? resource.name
			: typeof messageData.resourceName === 'string'
				? (messageData.resourceName as string)
				: undefined
	// Depending on event type the reference is a spaces/*, conferenceRecords/*,
	// or a nested transcript/recording resource.
	const spaceName = /^spaces\//.test(resourceName ?? '') ? resourceName : undefined
	const conferenceRecordName = /^conferenceRecords\//.test(resourceName ?? '')
		? resourceName?.split('/').slice(0, 2).join('/')
		: undefined
	return { eventType, resourceName, spaceName, conferenceRecordName }
}

/**
 * fanOutMeetEvent — fetch artefacts under the row's OAuth token and write
 * them to the linked meeting object.
 *
 * The returned NormalizedEvent[] carries one event per artefact type so
 * downstream consumer triggers fire with the right entityType/action. All
 * meeting-object metadata writes happen inside this function — writeback is
 * idempotent on metadata.google_meet_conference_record_name.
 */
export async function fanOutMeetEvent(ctx: WebhookFanOutContext): Promise<NormalizedEvent[]> {
	const db = ctx.db as Database
	// Best-effort schema-shape ensure so the first webhook lands into a
	// workspace whose meeting type carries every field we're about to write.
	// Idempotent; only mutates workspace.settings when a field is missing.
	try {
		await ensureMeetMeetingFields(db, ctx.workspaceId)
	} catch (err) {
		logger.warn('ensureMeetMeetingFields failed (continuing fan-out)', {
			workspaceId: ctx.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	const provider = getProvider('google-meet')
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, ctx.integrationId, provider)

	const data = ctx.normalized.data as Record<string, unknown>
	const parsed: FanOutPayload = {
		eventType: String(data.eventType ?? ctx.normalized.action ?? ''),
		resourceName: typeof data.resourceName === 'string' ? data.resourceName : undefined,
		spaceName: typeof data.spaceName === 'string' ? data.spaceName : undefined,
		conferenceRecordName:
			typeof data.conferenceRecordName === 'string' ? data.conferenceRecordName : undefined,
	}
	if (!parsed.eventType) return []

	// Resolve the conference record. For transcript/recording events the delivered
	// resource is nested (conferenceRecords/*/transcripts/*), so trim to the parent.
	if (!parsed.conferenceRecordName && parsed.resourceName) {
		const parts = parsed.resourceName.split('/')
		if (parts[0] === 'conferenceRecords' && parts.length >= 2) {
			parsed.conferenceRecordName = `${parts[0]}/${parts[1]}`
		}
	}

	const meetingId = await resolveLinkedMeeting(db, ctx.workspaceId, parsed)
	if (!meetingId) {
		logger.info('Meet event has no linked meeting object; nothing to write back', {
			workspaceId: ctx.workspaceId,
			conferenceRecordName: parsed.conferenceRecordName,
			spaceName: parsed.spaceName,
		})
		return []
	}

	const emitted: NormalizedEvent[] = []
	const installationId = ctx.normalized.installationId

	if (parsed.eventType.endsWith('conference.v2.ended')) {
		await writeMeetingMetadata(db, meetingId, {
			meet_conference_ended_at: new Date().toISOString(),
			artefact_state: 'pending',
			google_meet_conference_record_name:
				parsed.conferenceRecordName ?? undefined,
			artefact_last_polled_at: new Date().toISOString(),
		})
		emitted.push({
			entityType: 'google_meet.conference',
			action: 'ended',
			installationId,
			data: {
				conferenceRecordName: parsed.conferenceRecordName,
				spaceName: parsed.spaceName,
				meetingId,
			},
		})
	}

	if (parsed.eventType.endsWith('transcript.v2.fileGenerated') && parsed.conferenceRecordName) {
		await handleTranscriptReady(
			db,
			accessToken,
			meetingId,
			parsed.conferenceRecordName,
			ctx.storage,
			ctx.workspaceId,
		)
		emitted.push({
			entityType: 'google_meet.transcript',
			action: 'ready',
			installationId,
			data: { conferenceRecordName: parsed.conferenceRecordName, meetingId },
		})
	}

	if (parsed.eventType.endsWith('recording.v2.fileGenerated') && parsed.conferenceRecordName) {
		await handleRecordingReady(db, accessToken, meetingId, parsed.conferenceRecordName)
		emitted.push({
			entityType: 'google_meet.recording',
			action: 'ready',
			installationId,
			data: { conferenceRecordName: parsed.conferenceRecordName, meetingId },
		})
	}

	return emitted
}

async function resolveLinkedMeeting(
	db: Database,
	workspaceId: string,
	parsed: FanOutPayload,
): Promise<string | null> {
	// Prefer conference-record-name (idempotent), fall back to space-name.
	if (parsed.conferenceRecordName) {
		const rows = await db
			.select({ id: objects.id })
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'meeting'),
					sql`${objects.metadata}->>'google_meet_conference_record_name' = ${parsed.conferenceRecordName}`,
				),
			)
			.limit(1)
		if (rows[0]) return rows[0].id
	}
	if (parsed.spaceName) {
		const rows = await db
			.select({ id: objects.id })
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'meeting'),
					sql`${objects.metadata}->>'google_meet_space_name' = ${parsed.spaceName}`,
				),
			)
			.limit(1)
		if (rows[0]) return rows[0].id
	}
	return null
}

async function handleTranscriptReady(
	db: Database,
	accessToken: string,
	meetingId: string,
	conferenceRecordName: string,
	storage: unknown,
	workspaceId: string,
): Promise<void> {
	// List transcripts on the record, then walk entries for the first one.
	const transcripts = await fetchPages<MeetTranscript>(
		`${MEET_API_BASE}/${conferenceRecordName}/transcripts`,
		accessToken,
		'transcripts',
	)
	const transcript = transcripts[0]
	if (!transcript) return

	const entries = await fetchPages<MeetTranscriptEntry>(
		`${MEET_API_BASE}/${transcript.name}/entries`,
		accessToken,
		'transcriptEntries',
	)
	const participants = await fetchPages<MeetParticipant>(
		`${MEET_API_BASE}/${conferenceRecordName}/participants`,
		accessToken,
		'participants',
	).catch((err) => {
		logger.warn('Meet participants fetch failed on transcript ready', {
			conferenceRecordName,
			error: err instanceof Error ? err.message : String(err),
		})
		return [] as MeetParticipant[]
	})

	const participantsStructured = participants.map((p) => ({
		name: p.name,
		earliestStartTime: p.earliestStartTime,
		latestEndTime: p.latestEndTime,
		signedInUser: p.signedInUser,
		anonymousUser: p.anonymousUser,
		phoneUser: p.phoneUser,
	}))
	const participantsText = participants
		.map(
			(p) =>
				p.signedInUser?.displayName ??
				p.anonymousUser?.displayName ??
				p.phoneUser?.displayName ??
				'',
		)
		.filter(Boolean)
		.join(', ')

	await writeMeetingMetadata(db, meetingId, {
		google_meet_conference_record_name: conferenceRecordName,
		transcript_document_id: transcript.name,
		transcript_entries_snapshot: entries,
		transcript_status: 'ready',
		artefact_state: 'complete',
		artefact_last_polled_at: new Date().toISOString(),
		participants_structured: participantsStructured,
		participants: participantsText,
	})

	// Render markdown + attach — best-effort. Attachment idempotent on
	// metadata.google_meet_conference_record_name (set above).
	try {
		await attachTranscriptFile(db, storage, workspaceId, meetingId, transcript, entries)
	} catch (err) {
		logger.warn('Meet transcript file attach failed (metadata still written)', {
			meetingId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

async function handleRecordingReady(
	db: Database,
	accessToken: string,
	meetingId: string,
	conferenceRecordName: string,
): Promise<void> {
	const recordings = await fetchPages<MeetRecording>(
		`${MEET_API_BASE}/${conferenceRecordName}/recordings`,
		accessToken,
		'recordings',
	)
	const recording = recordings[0]
	if (!recording) return
	await writeMeetingMetadata(db, meetingId, {
		recording_drive_file_id: recording.driveDestination?.file,
		recording_export_uri: recording.driveDestination?.exportUri,
	})
}

/**
 * Called by the reconciler for meetings with a Meet space but no transcript
 * yet: list the record + rehydrate as if a transcript.fileGenerated push landed.
 * Returns true if it wrote a transcript, false if nothing was found yet.
 */
export async function reconcileMeetingArtefacts(
	db: Database,
	accessToken: string,
	workspaceId: string,
	meetingId: string,
	spaceName: string | undefined,
	storage: unknown,
): Promise<boolean> {
	if (!spaceName) return false
	const records = await callGoogleApi<{
		conferenceRecords?: MeetConferenceRecord[]
	}>(`${MEET_API_BASE}/conferenceRecords`, accessToken, {
		query: {
			filter: `space.name = "${spaceName}"`,
			pageSize: '5',
		},
	}).catch((err) => {
		if (err instanceof MeetToolError && err.envelope.error.provider_status === 404) {
			return { conferenceRecords: [] as MeetConferenceRecord[] }
		}
		throw err
	})
	const record = records.conferenceRecords?.[0]
	if (!record) return false

	await handleTranscriptReady(db, accessToken, meetingId, record.name, storage, workspaceId)
	// Also pull recording if any.
	try {
		await handleRecordingReady(db, accessToken, meetingId, record.name)
	} catch (err) {
		logger.warn('Reconciler recording fetch failed', {
			meetingId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return true
}

// Re-export the classifyGoogleApiError symbol for callers that don't import
// from './errors' directly (keeps the fan-out surface small).
export { classifyGoogleApiError }

// StoredCredentials imported for cross-file type parity with gmail watch.
export type { StoredCredentials }
