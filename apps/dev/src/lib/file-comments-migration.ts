import type { Database } from '@maskin/db'
import { fileComments, files } from '@maskin/db/schema'
import type { FileAnnotation } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'

// Marker written into `file_comments.selector` for rows ported from the
// pre-refactor `files.annotations` blob. Reserved: nothing else in the
// composer emits this value. The idempotence check for the one-shot port
// keys on the presence of any row with this selector for the file.
export const LEGACY_ANNOTATION_SELECTOR = 'legacy'

/**
 * One-shot per-file port of the legacy `files.annotations` viewport-fraction
 * pins into `file_comments` rows. Called from the file-comments GET route on
 * every read; only actually writes once per file — the presence of any row
 * with `selector = 'legacy'` for `fileId` is the idempotence marker, so a
 * second read never double-ports.
 *
 * Positions are preserved verbatim (per spec — legacy pin traffic is
 * trace-level in this workspace so accepting drift is cheaper than a
 * coordinate-migration engine).
 *
 * Runs inside a single transaction with a row-level lock on the file so two
 * concurrent first-reads of the same file can't each port the blob.
 */
export async function migrateLegacyAnnotationsIfNeeded(
	db: Database,
	fileId: string,
	fallbackAuthorId: string,
): Promise<{ migrated: number }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ annotations: files.annotations, createdBy: files.createdBy })
			.from(files)
			.where(eq(files.id, fileId))
			.for('update')
			.limit(1)

		if (!row) return { migrated: 0 }
		const annotations = (row.annotations ?? []) as FileAnnotation[]
		if (annotations.length === 0) return { migrated: 0 }

		const [alreadyMigrated] = await tx
			.select({ id: fileComments.id })
			.from(fileComments)
			.where(
				and(eq(fileComments.fileId, fileId), eq(fileComments.selector, LEGACY_ANNOTATION_SELECTOR)),
			)
			.limit(1)

		if (alreadyMigrated) return { migrated: 0 }

		const author = row.createdBy ?? fallbackAuthorId
		const values = annotations
			.filter((a) => a.comment && a.comment.trim().length > 0)
			.map((a) => ({
				fileId,
				page: null,
				positionDoc: a.position ?? {
					// If the legacy row lacks `position`, fall back to the pinned
					// element's top-left. Same drift acceptance as above — the
					// point is landing the row, not pixel-perfect placement.
					x: Math.min(Math.max(a.bounds?.x ?? 0, 0), 1),
					y: Math.min(Math.max(a.bounds?.y ?? 0, 0), 1),
				},
				selector: LEGACY_ANNOTATION_SELECTOR,
				authorId: author,
				body: a.comment,
				parentId: null,
				roundId: null,
				resolvedAt: null,
				resolvedBy: null,
			}))

		if (values.length === 0) return { migrated: 0 }
		await tx.insert(fileComments).values(values)
		return { migrated: values.length }
	})
}
