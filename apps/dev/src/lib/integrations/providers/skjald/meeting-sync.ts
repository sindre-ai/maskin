import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { SkjaldOutcomePayload, SkjaldTranscriptionCompletedPayload } from '@maskin/shared'
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
		.select({ id: objects.id, metadata: objects.metadata })
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

interface SaveMeetingArgs {
	workspaceId: string
	systemActorId: string
	/** Skjald's meeting id: what `metadata.external_id` matches on. */
	externalId: string
	title: string
	content: string | null
	/** The metadata to write, given what the meeting already has (null when it is new). */
	metadata: (existing: Record<string, unknown> | null) => Record<string, unknown>
}

/** Insert-or-update by `external_id`, including the fall-through when a concurrent delivery wins the insert. */
async function saveMeeting(
	db: Database,
	{ workspaceId, systemActorId, externalId, title, content, metadata }: SaveMeetingArgs,
): Promise<UpsertSkjaldMeetingResult> {
	const update = async (id: string, existingMetadata: Record<string, unknown> | null) => {
		await db
			.update(objects)
			.set({
				title,
				content,
				status: 'done',
				metadata: metadata(existingMetadata),
				updatedAt: new Date(),
			})
			.where(eq(objects.id, id))
		return { objectId: id, action: 'updated' as const }
	}

	const existing = await findByExternalId(db, workspaceId, externalId)
	if (existing) return update(existing.id, existing.metadata as Record<string, unknown> | null)

	try {
		const [created] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'meeting',
				title,
				content,
				status: 'done',
				metadata: metadata(null),
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

		const raced = await findByExternalId(db, workspaceId, externalId)
		if (!raced) throw err
		return update(raced.id, raced.metadata as Record<string, unknown> | null)
	}
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
		// `_`-prefixed key: hidden from the object Properties panel (see
		// metadata-properties.tsx / metadata-badges.tsx's `startsWith('_')` filter)
		// and JSON-stringified rather than stored as a nested array, since
		// `safeMetadataSchema` (packages/shared/src/schemas/primitives.ts) only
		// allows scalars and arrays of scalars — an array of segment objects would
		// fail validation the next time any property on this object is edited or
		// removed through the standard PATCH /api/objects/:id route, which
		// round-trips the full metadata blob.
		_speaker_segments: payload.speaker_segments ? JSON.stringify(payload.speaker_segments) : null,
	}

	return saveMeeting(db, {
		workspaceId,
		systemActorId,
		externalId: payload.meeting_id,
		title: payload.meeting_title,
		content: payload.transcript_text ?? null,
		metadata: () => metadata,
	})
}

export interface UpsertSkjaldOutcomeArgs {
	workspaceId: string
	systemActorId: string
	payload: SkjaldOutcomePayload
}

function bulletSection(heading: string, items: string[]): string[] {
	const lines = items.map((item) => item.trim()).filter(Boolean)
	return lines.length ? [`## ${heading}`, ...lines.map((line) => `- ${line}`), ''] : []
}

/** The outcome as the meeting's markdown body: summary, decisions, actions, notes, then the transcript if sent. */
export function renderOutcomeContent(payload: SkjaldOutcomePayload): string {
	const { outcome, transcript } = payload
	const parts: string[] = []
	if (outcome.summary.trim()) parts.push('## Summary', outcome.summary.trim(), '')
	parts.push(
		...bulletSection('Decisions', outcome.decisions),
		...bulletSection('Actions', outcome.actions),
		...bulletSection('Notes', outcome.notes),
	)
	if (transcript?.length) {
		parts.push('## Transcript')
		for (const line of transcript) parts.push(`**${line.speaker}:** ${line.text}`, '')
	}
	return parts.join('\n').trim()
}

/**
 * Upserts a `meeting` object for a Skjald `outcome.created` / `outcome.updated` delivery (what the iOS app and the
 * v2 destinations send). Same meeting object and the same `external_id` match as `transcription.completed`
 * (`session.id` is the meeting id), so the two events never make two meetings. The body becomes the written-up
 * outcome; anything the other event stored in metadata (diarization, speaker segments) is kept.
 */
export async function upsertSkjaldOutcomeMeeting(
	db: Database,
	{ workspaceId, systemActorId, payload }: UpsertSkjaldOutcomeArgs,
): Promise<UpsertSkjaldMeetingResult> {
	const { session } = payload
	return saveMeeting(db, {
		workspaceId,
		systemActorId,
		externalId: session.id,
		title: session.title.trim() || 'Untitled meeting',
		content: renderOutcomeContent(payload) || null,
		metadata: (existing) => ({
			...(existing ?? {}),
			external_id: session.id,
			source: 'skjald',
			started_at: session.startedAt,
			duration_seconds: session.duration,
			languages: session.languages,
			tag: session.tag ?? null,
			device_model: payload.device?.model ?? null,
			skjald_app_version: payload.device?.appVersion ?? null,
		}),
	})
}
