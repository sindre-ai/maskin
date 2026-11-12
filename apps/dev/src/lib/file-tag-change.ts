import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import { recordEvent } from './events/record-event'

export type FileTagChangeKind = 'rename' | 'merge'

export class FileTagNotFoundError extends Error {
	constructor(readonly tag: string) {
		super(`No file in this workspace carries the tag "${tag}"`)
	}
}

export class FileTagExistsError extends Error {
	constructor(readonly tag: string) {
		super(`The tag "${tag}" already exists; merge into it instead`)
	}
}

/**
 * Swaps `from` for `to` on every file in the workspace, in one transaction: either every
 * file changes or none does, and one audit event records it. A file that already carries
 * `to` keeps one copy. The swap never adds a tag to a file (it replaces one, or drops one
 * when `to` was already there), so no file can pass the per-file tag limit.
 */
export async function changeFileTag(
	db: Database,
	params: {
		workspaceId: string
		actorId: string
		kind: FileTagChangeKind
		from: string
		to: string
	},
): Promise<number> {
	const { workspaceId, actorId, kind, from, to } = params
	return db.transaction(async (tx) => {
		if (kind === 'rename') {
			const taken = await tx.execute(sql`
				SELECT 1 FROM files
				WHERE workspace_id = ${workspaceId} AND tags @> ARRAY[${to}]::text[]
				LIMIT 1
			`)
			if (taken.length > 0) throw new FileTagExistsError(to)
		}

		// Replace in place so the other tags keep their order; GROUP BY drops the repeat when
		// the file already had `to`.
		const changed = await tx.execute(sql`
			UPDATE files
			SET tags = ARRAY(
				SELECT s.x FROM (
					SELECT CASE WHEN u.t = ${from}::text THEN ${to}::text ELSE u.t END AS x, u.ord
					FROM unnest(files.tags) WITH ORDINALITY AS u(t, ord)
				) s
				GROUP BY s.x
				ORDER BY min(s.ord)
			),
			updated_at = now()
			WHERE workspace_id = ${workspaceId} AND tags @> ARRAY[${from}]::text[]
			RETURNING id
		`)
		if (changed.length === 0) throw new FileTagNotFoundError(from)

		// A large upload that has not finished would bring the old tag back when it completes.
		await tx.execute(sql`
			UPDATE file_uploads
			SET tags = ARRAY(
				SELECT s.x FROM (
					SELECT CASE WHEN u.t = ${from}::text THEN ${to}::text ELSE u.t END AS x, u.ord
					FROM unnest(file_uploads.tags) WITH ORDINALITY AS u(t, ord)
				) s
				GROUP BY s.x
				ORDER BY min(s.ord)
			)
			WHERE workspace_id = ${workspaceId}
				AND status IN ('pending', 'completing')
				AND tags @> ARRAY[${from}]::text[]
		`)

		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: kind === 'rename' ? 'file_tag_renamed' : 'file_tags_merged',
			entityType: 'workspace',
			entityId: workspaceId,
			data: { from, to, files_changed: changed.length },
		})
		return changed.length
	})
}
