import type { Database, Transaction } from '@maskin/db'
import { integrations, triggers } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { GOOGLE_DRIVE_PROVIDER } from './token'

/**
 * Read and stop for the folder watches the folder-watch task writes into
 * config.drive.watchedFolders on a Drive row. That task owns the writes
 * (including lastFiredAt), so the reader is tolerant: an entry that does not
 * parse is skipped rather than failing the whole list.
 *
 * A workspace can hold more than one Drive row (one per connected Google
 * account), so the list is the union across the workspace's rows and each watch
 * carries the account it lives on.
 */

const timestampSchema = z.union([z.string(), z.number()])

const watchedFolderSchema = z.object({
	folderId: z.string().min(1),
	name: z.string(),
	path: z.string().optional(),
	addedAt: timestampSchema.optional(),
	lastFiredAt: timestampSchema.optional(),
})

export interface DriveWatch {
	folderId: string
	name: string
	path: string | null
	addedAt: string | null
	lastFiredAt: string | null
	integrationId: string
	/** Google account the watch lives on (the Drive row's external id). */
	account: string | null
	/** Enabled event triggers whose filter names this folder. Empty when none. */
	triggers: { id: string; name: string }[]
}

function toIso(value: string | number | undefined): string | null {
	if (value === undefined) return null
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** True when `value` is, or contains at any depth, the folder id. Covers a plain
 *  equality filter, an any-of array and the v2 matcher's operator objects
 *  without hard-coding which payload key the trigger author filtered on. */
function mentionsFolder(value: unknown, folderId: string): boolean {
	if (value === folderId) return true
	if (Array.isArray(value)) return value.some((v) => mentionsFolder(v, folderId))
	if (value !== null && typeof value === 'object') {
		return Object.values(value).some((v) => mentionsFolder(v, folderId))
	}
	return false
}

function triggerReferencesFolder(config: unknown, folderId: string): boolean {
	const { entity_type: entityType, filter } = (config ?? {}) as {
		entity_type?: unknown
		filter?: unknown
	}
	if (typeof entityType !== 'string' || !entityType.startsWith('google_drive.')) return false
	return mentionsFolder(filter, folderId)
}

export async function listDriveWatches(db: Database, workspaceId: string): Promise<DriveWatch[]> {
	// A revoked or never-finished row has no live channel, so its watches are not
	// shown; an errored row (needs reconnect) still lists so it can be stopped.
	const rows = await db
		.select({
			id: integrations.id,
			externalId: integrations.externalId,
			config: integrations.config,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, GOOGLE_DRIVE_PROVIDER),
				inArray(integrations.status, ['active', 'error']),
			),
		)

	const entries = rows.flatMap((row) => {
		const raw = (row.config as { drive?: { watchedFolders?: unknown } } | null)?.drive
			?.watchedFolders
		if (!Array.isArray(raw)) return []
		return raw.flatMap((item) => {
			const parsed = watchedFolderSchema.safeParse(item)
			return parsed.success ? [{ row, entry: parsed.data }] : []
		})
	})
	if (entries.length === 0) return []

	const triggerRows = await db
		.select({ id: triggers.id, name: triggers.name, config: triggers.config })
		.from(triggers)
		.where(
			and(
				eq(triggers.workspaceId, workspaceId),
				eq(triggers.type, 'event'),
				eq(triggers.enabled, true),
			),
		)

	return entries.map(({ row, entry }) => ({
		folderId: entry.folderId,
		name: entry.name,
		path: entry.path ?? null,
		addedAt: toIso(entry.addedAt),
		lastFiredAt: toIso(entry.lastFiredAt),
		integrationId: row.id,
		account: row.externalId,
		triggers: triggerRows
			.filter((t) => triggerReferencesFolder(t.config, entry.folderId))
			.map((t) => ({ id: t.id, name: t.name })),
	}))
}

/**
 * Remove the folder from config.drive.watchedFolders on every Drive row in the
 * workspace that holds it. One UPDATE, so the filter and the write cannot
 * interleave with another writer touching a different part of the same row, and
 * the returned ids are the not-found signal. Returns the ids of the rows changed;
 * empty means the workspace has no such watch.
 *
 * The inner reference is written as literal "integrations.config": a Drizzle
 * column object inside a correlated subquery renders unqualified (see
 * known-pitfalls.md).
 */
export async function stopDriveWatch(
	db: Database | Transaction,
	workspaceId: string,
	folderId: string,
): Promise<string[]> {
	const containsFolder = JSON.stringify([{ folderId }])
	const rows = await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(
				integrations.config,
				'{drive,watchedFolders}',
				COALESCE(
					(SELECT jsonb_agg(entry)
					 FROM jsonb_array_elements(integrations.config->'drive'->'watchedFolders') AS entry
					 WHERE entry->>'folderId' IS DISTINCT FROM ${folderId}),
					'[]'::jsonb
				),
				false
			)`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, GOOGLE_DRIVE_PROVIDER),
				sql`integrations.config->'drive'->'watchedFolders' @> ${containsFolder}::jsonb`,
			),
		)
		.returning({ id: integrations.id })
	return rows.map((r) => r.id)
}
