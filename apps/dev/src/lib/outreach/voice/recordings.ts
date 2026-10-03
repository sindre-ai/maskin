import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import AdmZip from 'adm-zip'
import { and, eq, ne, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import type { CallRecording } from '../../integrations/providers/telnyx/client'
import { logger } from '../../logger'

/** Statuses whose hangup has a completed leg worth keeping (spec section 5). */
export const MIRROR_STATUSES: ReadonlySet<string> = new Set([
	'voice_meeting_booked',
	'voice_warm_transferred',
	'voice_declined',
])

/** Set by the erasure request. Read from the stored status; this module never writes it. */
export const DELETED_BY_REQUEST = 'deleted_by_request'

export const RETENTION_MONTHS = 24

/** Delays between attempts. Telnyx recording timing is unverified, so the window is generous. */
export const MIRROR_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000, 120_000, 300_000, 600_000]

export const voiceBlobPrefix = (contactId: string) => `voice-outreach/${contactId}/`
export const recordingKey = (contactId: string, callId: string) =>
	`${voiceBlobPrefix(contactId)}${callId}.mp3`
export const transcriptKey = (contactId: string, callId: string) =>
	`${voiceBlobPrefix(contactId)}${callId}.json`

const ISO_UTC = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`

export interface VoiceTouch {
	workspaceId: string
	contactId: string
	touchedAt: Date
	/** Extra metadata merged in the same write (the mirror's blob keys). */
	patch?: Record<string, string>
}

/**
 * THE writer of voice_last_touch_at, voice_first_touch_at and retention_expires_at.
 * A later email path (a second email, a reminder) must call this in the same flow
 * as the send, so the 24-month blob clock follows the last contact.
 *
 * One JSONB merge patch in a single UPDATE, not read-modify-write: the email send and
 * the mirror both run off the hangup seam. voice_last_touch_at only moves forward,
 * voice_first_touch_at is set once. Returns false, writing nothing, when the contact
 * is deleted_by_request (or missing), so the caller can undo any blobs it wrote.
 */
export async function stampVoiceTouch(db: Database, touch: VoiceTouch): Promise<boolean> {
	const at = touch.touchedAt.toISOString()
	const lastTouch = sql`greatest(${at}::timestamptz, nullif(${objects.metadata}->>'voice_last_touch_at', '')::timestamptz)`
	const rows = await db
		.update(objects)
		.set({
			metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb)
				|| ${JSON.stringify(touch.patch ?? {})}::jsonb
				|| jsonb_build_object(
					'voice_last_touch_at', to_char((${lastTouch}) at time zone 'UTC', ${ISO_UTC}::text),
					'retention_expires_at', to_char(((${lastTouch}) at time zone 'UTC') + ${sql.raw(`interval '${RETENTION_MONTHS} months'`)}, ${ISO_UTC}::text),
					'voice_first_touch_at', coalesce(nullif(${objects.metadata}->>'voice_first_touch_at', ''), ${at}::text)
				)`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(objects.id, touch.contactId),
				eq(objects.workspaceId, touch.workspaceId),
				eq(objects.type, 'contact'),
				ne(objects.status, DELETED_BY_REQUEST),
			),
		)
		.returning({ id: objects.id })
	return rows.length > 0
}

export interface MirrorContact {
	workspaceId: string
	contactId: string
}

export interface MirrorCall {
	callId: string
	/** Call end time; becomes voice_last_touch_at. */
	endedAt: Date
	recordingUrl: string | null
	transcriptUrl: string | null
}

export interface MirrorDeps {
	db: Database
	storage: StorageProvider
	/** Telnyx recording lookup by call id, used when the hangup carried no recording URL. */
	findRecording: (callId: string) => Promise<CallRecording | null>
	fetchImpl?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	retryDelaysMs?: readonly number[]
}

export type MirrorResult =
	| { outcome: 'mirrored'; attempts: number; recordingKey: string; transcriptKey: string }
	| { outcome: 'skipped_erased' }
	| { outcome: 'failed'; attempts: number; reason: string }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function isErased(db: Database, contact: MirrorContact): Promise<boolean> {
	const [row] = await db
		.select({ status: objects.status })
		.from(objects)
		.where(and(eq(objects.id, contact.contactId), eq(objects.workspaceId, contact.workspaceId)))
		.limit(1)
	return row?.status === DELETED_BY_REQUEST
}

/** The actor an audit row for this contact is attributed to, as the reducer does. */
export async function contactActorId(db: Database, contactId: string): Promise<string | null> {
	const [row] = await db
		.select({ driver: objects.driver, createdBy: objects.createdBy })
		.from(objects)
		.where(eq(objects.id, contactId))
		.limit(1)
	return row ? (row.driver ?? row.createdBy) : null
}

async function download(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
	// Pre-signed URL: no Authorization header, so the Telnyx key never goes to the file host.
	const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) })
	if (!res.ok) throw new Error(`download of ${new URL(url).host} failed with ${res.status}`)
	return Buffer.from(await res.arrayBuffer())
}

async function bestEffortDelete(storage: StorageProvider, keys: string[]): Promise<void> {
	for (const key of keys) {
		await storage.delete(key).catch((err) =>
			logger.warn('voice mirror cleanup failed', {
				key,
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	}
}

/**
 * Copies a call's recording and transcript into S3 and stamps the contact. Plain
 * function: the post-call hook runs it in the background, never the webhook path.
 *
 * Retries cover a recording Telnyx has not finished yet and a failed download. Telnyx
 * keeps hosting the recording, so a mirror that exhausts its retries loses nothing.
 * If the contact is (or becomes) deleted_by_request, nothing is left behind: the check
 * runs before each attempt and again as the condition on the final metadata write.
 */
export async function mirrorCallArtifacts(
	contact: MirrorContact,
	call: MirrorCall,
	deps: MirrorDeps,
): Promise<MirrorResult> {
	const sleep = deps.sleep ?? defaultSleep
	const delays = deps.retryDelaysMs ?? MIRROR_RETRY_DELAYS_MS
	const fetchImpl = deps.fetchImpl ?? fetch
	const mp3Key = recordingKey(contact.contactId, call.callId)
	const jsonKey = transcriptKey(contact.contactId, call.callId)
	let lastReason = 'unknown'

	for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
		if (attempt > 1) await sleep(delays[attempt - 2] as number)
		if (await isErased(deps.db, contact)) return { outcome: 'skipped_erased' }

		let wrote = false
		try {
			let recordingUrl = call.recordingUrl
			if (!recordingUrl) {
				const found = await deps.findRecording(call.callId)
				if (!found) throw new Error('recording not found for call yet')
				if (found.status !== 'completed' || !found.mp3Url) {
					throw new Error(`recording not ready (status ${found.status})`)
				}
				recordingUrl = found.mp3Url
			}
			if (!call.transcriptUrl) throw new Error('transcript not available yet')

			const mp3 = await download(fetchImpl, recordingUrl)
			const transcript = await download(fetchImpl, call.transcriptUrl)
			JSON.parse(transcript.toString('utf8'))

			wrote = true
			await deps.storage.put(mp3Key, mp3)
			await deps.storage.put(jsonKey, transcript)
			const stamped = await stampVoiceTouch(deps.db, {
				...contact,
				touchedAt: call.endedAt,
				patch: { last_call_recording_id: mp3Key, last_call_transcript_id: jsonKey },
			})
			if (!stamped) {
				// Erased between the check above and now: undo what this attempt wrote.
				await bestEffortDelete(deps.storage, [mp3Key, jsonKey])
				return { outcome: 'skipped_erased' }
			}
			await recordMirrorEvent(deps.db, contact, call.callId, [mp3Key, jsonKey])
			return {
				outcome: 'mirrored',
				attempts: attempt,
				recordingKey: mp3Key,
				transcriptKey: jsonKey,
			}
		} catch (err) {
			if (wrote) await bestEffortDelete(deps.storage, [mp3Key, jsonKey])
			lastReason = err instanceof Error ? err.message : String(err)
			logger.warn('voice mirror attempt failed', {
				callId: call.callId,
				contactId: contact.contactId,
				attempt,
				reason: lastReason,
			})
		}
	}
	return { outcome: 'failed', attempts: delays.length + 1, reason: lastReason }
}

async function recordMirrorEvent(
	db: Database,
	contact: MirrorContact,
	callId: string,
	keys: string[],
): Promise<void> {
	try {
		const actorId = await contactActorId(db, contact.contactId)
		if (!actorId) return
		await recordEvent(db, {
			workspaceId: contact.workspaceId,
			actorId,
			action: 'updated',
			entityType: 'object',
			entityId: contact.contactId,
			data: { source: 'voice_mirror', call_id: callId, keys },
		})
	} catch (err) {
		// The blobs and the stamp are already in place; a missing audit row must not undo them.
		logger.error('voice mirror audit event failed', {
			callId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** Deletes every voice-outreach blob for a contact. Throws if listing or any delete fails. */
export async function deleteVoiceBlobs(
	storage: StorageProvider,
	contactId: string,
): Promise<number> {
	const keys = await storage.list(voiceBlobPrefix(contactId))
	for (const key of keys) await storage.delete(key)
	return keys.length
}

/**
 * GDPR access request: the contact row plus every voice-outreach blob for it, zipped.
 * No route or UI calls this yet (out of scope for the recordings task).
 */
export async function buildAccessExport(
	db: Database,
	storage: StorageProvider,
	contact: MirrorContact,
): Promise<Buffer | null> {
	const [row] = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.id, contact.contactId),
				eq(objects.workspaceId, contact.workspaceId),
				eq(objects.type, 'contact'),
			),
		)
		.limit(1)
	if (!row) return null

	const zip = new AdmZip()
	zip.addFile('contact.json', Buffer.from(JSON.stringify(row, null, 2), 'utf8'))
	for (const key of await storage.list(voiceBlobPrefix(contact.contactId))) {
		zip.addFile(key, await storage.get(key))
	}
	return zip.toBuffer()
}
