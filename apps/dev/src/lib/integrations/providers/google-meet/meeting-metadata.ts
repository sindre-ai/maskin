import type { Database } from '@maskin/db'
import { files, integrations, objects, relationships, workspaces } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'

/**
 * Meeting-object metadata fields the google-meet fan-out writes. Kept as a
 * declared list so ensureMeetMeetingFields can idempotently register them on
 * the workspace's schema (visible via get_workspace_schema, accepted by
 * create_objects / update_objects).
 */
export const MEET_MEETING_FIELDS: Array<{
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	values?: string[]
}> = [
	{ name: 'google_meet_space_name', type: 'text' },
	{ name: 'google_meet_conference_record_name', type: 'text' },
	{ name: 'google_meet_meeting_code', type: 'text' },
	{ name: 'participants_structured', type: 'text' },
	{ name: 'transcript_document_id', type: 'text' },
	{ name: 'transcript_export_uri', type: 'text' },
	{ name: 'transcript_entries_snapshot', type: 'text' },
	{ name: 'recording_drive_file_id', type: 'text' },
	{ name: 'recording_export_uri', type: 'text' },
	{
		name: 'artefact_state',
		type: 'enum',
		values: ['pending', 'partial', 'complete', 'failed', 'not_recorded'],
	},
	{ name: 'artefact_last_polled_at', type: 'date' },
	{ name: 'meet_conference_ended_at', type: 'date' },
	{ name: 'transcript_status', type: 'enum', values: ['pending', 'ready', 'unavailable'] },
]

interface FieldDef {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

/**
 * Idempotently registers the meeting metadata fields on the workspace's
 * settings.field_definitions.meeting slot. Only adds — never removes. Called
 * before the first webhook fan-out so the schema is present.
 */
export async function ensureMeetMeetingFields(
	db: Database,
	workspaceId: string,
): Promise<void> {
	const [ws] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws) return
	const settings = (ws.settings as Record<string, unknown>) ?? {}
	const fieldDefs =
		(settings.field_definitions as Record<string, FieldDef[]> | undefined) ?? {}
	const existing = fieldDefs.meeting ?? []
	const byName = new Map(existing.map((f) => [f.name, f]))
	let mutated = false
	for (const spec of MEET_MEETING_FIELDS) {
		const current = byName.get(spec.name)
		if (!current) {
			byName.set(spec.name, {
				name: spec.name,
				type: spec.type,
				...(spec.values ? { values: spec.values } : {}),
			})
			mutated = true
			continue
		}
		if (spec.type === 'enum' && spec.values) {
			const currentValues = new Set(current.values ?? [])
			for (const v of spec.values) {
				if (!currentValues.has(v)) {
					current.values = [...(current.values ?? []), v]
					mutated = true
				}
			}
		}
	}
	if (!mutated) return
	fieldDefs.meeting = Array.from(byName.values())
	const nextSettings = { ...settings, field_definitions: fieldDefs }
	await db.update(workspaces).set({ settings: nextSettings }).where(eq(workspaces.id, workspaceId))
	logger.info('Meet meeting-metadata fields ensured', {
		workspaceId,
		count: byName.size,
	})
}

export type MeetMetadataPatch = Record<string, unknown>

/**
 * Merge a meeting-metadata patch into objects.metadata. Uses jsonb || to keep
 * unrelated keys intact. Undefined / null values in the patch are dropped so a
 * "fetched empty" recording doesn't erase existing metadata.
 */
export async function writeMeetingMetadata(
	db: Database,
	meetingId: string,
	patch: MeetMetadataPatch,
): Promise<void> {
	const compact: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined || v === null) continue
		compact[k] = v
	}
	if (Object.keys(compact).length === 0) return
	const patchJson = JSON.stringify(compact)
	await db
		.update(objects)
		.set({
			metadata: sql`COALESCE(${objects.metadata}, '{}'::jsonb) || ${patchJson}::jsonb`,
			updatedAt: new Date(),
		})
		.where(eq(objects.id, meetingId))
}

interface TranscriptFileInput {
	name: string
	startTime?: string
	endTime?: string
}

interface TranscriptEntryInput {
	participant?: string
	text?: string
	languageCode?: string
	startTime?: string
	endTime?: string
}

interface StoragePutLike {
	put: (key: string, data: Buffer | Uint8Array) => Promise<void>
}

function isStorageLike(x: unknown): x is StoragePutLike {
	return typeof x === 'object' && x !== null && typeof (x as StoragePutLike).put === 'function'
}

async function resolveSystemActorId(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	// The workspace's google-meet integration row stores its system actor id
	// in config.system_actor_id; every fan-out is scoped to that actor.
	const [row] = await db
		.select({ config: integrations.config })
		.from(integrations)
		.where(
			and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'google-meet')),
		)
		.limit(1)
	const cfg = (row?.config as IntegrationConfig | null) ?? null
	const actorId = cfg?.system_actor_id
	if (typeof actorId !== 'string' || actorId.length === 0) return null
	return actorId
}

/**
 * Render + attach the transcript as a markdown file on the meeting object.
 * Idempotent on the storage-key derived from transcript.name — a second call
 * for the same transcript returns the existing file id without a second write.
 */
export async function attachTranscriptFile(
	db: Database,
	storage: unknown,
	workspaceId: string,
	meetingId: string,
	transcript: TranscriptFileInput,
	entries: TranscriptEntryInput[],
): Promise<string | null> {
	const actorId = await resolveSystemActorId(db, workspaceId)
	if (!actorId) {
		logger.warn('Meet transcript attach skipped: no system_actor_id on integration', {
			workspaceId,
			meetingId,
		})
		return null
	}
	const storageKey = `workspaces/${workspaceId}/meet-transcripts/${transcript.name.replace(/[^A-Za-z0-9_-]/g, '_')}.md`
	// Idempotency: if a file with the same storageKey already exists on this
	// meeting via the attached relationship, reuse it.
	const existing = await db
		.select({ id: files.id, storageKey: files.storageKey })
		.from(files)
		.innerJoin(
			relationships,
			and(
				eq(relationships.targetType, 'file'),
				eq(relationships.targetId, files.id),
				eq(relationships.sourceType, 'object'),
				eq(relationships.sourceId, meetingId),
				eq(relationships.type, 'attached'),
			),
		)
		.where(and(eq(files.workspaceId, workspaceId), eq(files.storageKey, storageKey)))
		.limit(1)
	if (existing[0]) return existing[0].id

	const markdown = renderTranscriptMarkdown(transcript, entries)
	const contentBytes = Buffer.from(markdown, 'utf-8')
	const fileId = randomUUID()
	const [inserted] = await db
		.insert(files)
		.values({
			id: fileId,
			workspaceId,
			name: `Meet transcript ${new Date().toISOString()}.md`,
			description: null,
			mimeType: 'text/markdown',
			sizeBytes: contentBytes.byteLength,
			storageKey,
			createdBy: actorId,
		})
		.returning({ id: files.id })
	if (!inserted) return null
	if (isStorageLike(storage)) {
		try {
			await storage.put(storageKey, contentBytes)
		} catch (err) {
			logger.warn('Meet transcript storage upload failed (file row kept)', {
				meetingId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
	await db.insert(relationships).values({
		sourceType: 'object',
		sourceId: meetingId,
		targetType: 'file',
		targetId: inserted.id,
		type: 'attached',
		createdBy: actorId,
	})
	return inserted.id
}

function renderTranscriptMarkdown(
	transcript: TranscriptFileInput,
	entries: TranscriptEntryInput[],
): string {
	const lines: string[] = []
	lines.push('# Google Meet transcript')
	lines.push('')
	if (transcript.startTime) lines.push(`- Started: ${transcript.startTime}`)
	if (transcript.endTime) lines.push(`- Ended: ${transcript.endTime}`)
	lines.push(`- Google resource: ${transcript.name}`)
	lines.push('')
	lines.push('---')
	lines.push('')
	for (const entry of entries) {
		const speaker = entry.participant ?? 'Unknown speaker'
		const ts = entry.startTime ? ` (${entry.startTime})` : ''
		lines.push(`**${speaker}**${ts}`)
		lines.push('')
		lines.push(entry.text ?? '')
		lines.push('')
	}
	return lines.join('\n')
}
