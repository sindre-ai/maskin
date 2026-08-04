import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { SkjaldTranscriptionCompletedPayload } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'

// Name of the partial unique index defined in
// packages/db/drizzle/0049_objects_meeting_external_id_idx.sql — the DB-side
// backstop for the check-then-insert TOCTOU race below. Kept as a single
// string so this file and the migration stay in lockstep.
export const MEETING_EXTERNAL_ID_UNIQUE_CONSTRAINT = 'objects_ws_meeting_external_id_unique_idx'

/**
 * True if `err` (or any error in its `.cause` chain) is a Postgres
 * `unique_violation` (SQLSTATE 23505) raised by the meeting-external-id
 * partial unique index. Drizzle wraps the driver's PostgresError as
 * `err.cause` — same walk as `isKnowledgeTitleUniqueViolation`.
 */
export function isMeetingExternalIdUniqueViolation(err: unknown): boolean {
	for (let current: unknown = err; current && typeof current === 'object'; ) {
		const e = current as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === MEETING_EXTERNAL_ID_UNIQUE_CONSTRAINT) return true
			if (
				typeof e.message === 'string' &&
				e.message.includes(MEETING_EXTERNAL_ID_UNIQUE_CONSTRAINT)
			)
				return true
		}
		current = e.cause
	}
	return false
}

export interface UpsertSkjaldMeetingArgs {
	workspaceId: string
	systemActorId: string
	payload: SkjaldTranscriptionCompletedPayload
}

export interface UpsertSkjaldMeetingResult {
	objectId: string
	action: 'created' | 'updated'
}

async function findByExternalId(db: Database, workspaceId: string, meetingId: string) {
	const [existing] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'meeting'),
				sql`${objects.metadata}->>'external_id' = ${meetingId}`,
			),
		)
		.limit(1)
	return existing ?? null
}

/**
 * Deterministically upserts a `meeting` object for a Skjald
 * `transcription.completed` delivery — no agent tool call involved, so a
 * finished meeting always shows up even if no agent session ever runs.
 * Matches by `metadata->>'external_id' = payload.meeting_id`, scoped to the
 * workspace — an exact-id lookup, unlike `findKnowledgeDuplicate`'s fuzzy
 * title matching (apps/dev/src/lib/knowledge-dedup.ts).
 */
export async function upsertSkjaldMeeting(
	db: Database,
	{ workspaceId, systemActorId, payload }: UpsertSkjaldMeetingArgs,
): Promise<UpsertSkjaldMeetingResult> {
	const metadata = {
		external_id: payload.meeting_id,
		source: 'skjald',
		folder_path: payload.folder_path ?? null,
		segment_count: payload.segment_count,
		diarization_status: payload.diarization_status,
		speaker_segments: payload.speaker_segments ?? null,
	}

	const existing = await findByExternalId(db, workspaceId, payload.meeting_id)
	if (existing) {
		await db
			.update(objects)
			.set({
				title: payload.meeting_title,
				content: payload.transcript_text ?? null,
				status: 'done',
				metadata,
				updatedAt: new Date(),
			})
			.where(eq(objects.id, existing.id))
		return { objectId: existing.id, action: 'updated' }
	}

	try {
		const [created] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'meeting',
				title: payload.meeting_title,
				content: payload.transcript_text ?? null,
				status: 'done',
				metadata,
				createdBy: systemActorId,
			})
			.returning({ id: objects.id })
		if (!created) throw new Error('Insert returned no row')
		return { objectId: created.id, action: 'created' }
	} catch (err) {
		// TOCTOU backstop: a concurrent delivery for the same meeting_id (e.g. a
		// webhook retry racing the original) can pass the findByExternalId check
		// above and then collide on the unique index. Fall through to update.
		if (!isMeetingExternalIdUniqueViolation(err)) throw err

		const raced = await findByExternalId(db, workspaceId, payload.meeting_id)
		if (!raced) throw err
		await db
			.update(objects)
			.set({
				title: payload.meeting_title,
				content: payload.transcript_text ?? null,
				status: 'done',
				metadata,
				updatedAt: new Date(),
			})
			.where(eq(objects.id, raced.id))
		return { objectId: raced.id, action: 'updated' }
	}
}
