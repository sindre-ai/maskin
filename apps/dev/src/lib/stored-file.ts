import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import { recordEvent } from './events/record-event'

type StoredFileInput = Pick<
	typeof files.$inferInsert,
	| 'id'
	| 'workspaceId'
	| 'name'
	| 'description'
	| 'kind'
	| 'tags'
	| 'mimeType'
	| 'sizeBytes'
	| 'storageKey'
	| 'contentHash'
	| 'createdBy'
>

/**
 * The file row for bytes that are already in storage (a direct upload that finished). Throws
 * if no row comes back, so the caller can undo the stored object.
 */
export async function insertStoredFile(
	db: Database,
	input: StoredFileInput,
): Promise<typeof files.$inferSelect> {
	const [created] = await db.insert(files).values(input).returning()
	if (!created) throw new Error('Insert returned no row')
	return created
}

/** The audit event for a new file. Never includes content (8KB NOTIFY cap). */
export function recordFileCreated(
	db: Database,
	input: { file: typeof files.$inferSelect; actorId: string; sessionId?: string },
) {
	return recordEvent(db, {
		workspaceId: input.file.workspaceId,
		actorId: input.actorId,
		action: 'created',
		entityType: 'file',
		entityId: input.file.id,
		data: {
			id: input.file.id,
			name: input.file.name,
			mimeType: input.file.mimeType,
			sizeBytes: input.file.sizeBytes,
		},
		provenance: { sessionId: input.sessionId, entityKind: 'file' },
	})
}
