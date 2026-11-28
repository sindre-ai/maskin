import type { Database, Transaction } from '@maskin/db'
import { trash } from '@maskin/db/schema'

/**
 * The entity tables a delete can move to the trash. A flow is an object of type
 * 'loop', so it travels as kind 'object' with its membership edges in `extra`.
 */
export type TrashKind = 'object' | 'file' | 'trigger' | 'relationship' | 'workspace_skill'

/** How long a deleted row stays restorable before the purge job removes it. */
export const TRASH_RETENTION_DAYS = 30
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Accepts a top-level connection or a transaction, so a delete stays one commit. */
export type TrashWriter = Database | Transaction

export interface MoveToTrashParams {
	workspaceId: string
	kind: TrashKind
	entityId: string
	/** The full deleted row, as Drizzle selected it. */
	row: object
	/** Restore aid: a loop's in_loop edges, a workspace skill's agent attachments, or the flows a trigger was pruned from. */
	extra?: Record<string, unknown> | null
	deletedBy: string
	/** Overrides the default deleted_at + retention window. Tests use this. */
	now?: Date
}

/**
 * Copy a deleted row into the trash, inside the caller's delete transaction.
 *
 * The row is stored verbatim as jsonb, so a restore is an INSERT of exactly what was
 * deleted. purge_at is deleted_at + the 30 day retention window; a file or workspace
 * skill keeps its stored bytes until then.
 */
export async function moveToTrash(writer: TrashWriter, params: MoveToTrashParams): Promise<void> {
	const now = params.now ?? new Date()
	await writer.insert(trash).values({
		workspaceId: params.workspaceId,
		kind: params.kind,
		entityId: params.entityId,
		row: params.row as unknown as never,
		extra: (params.extra ?? null) as unknown as never,
		deletedBy: params.deletedBy,
		deletedAt: now,
		purgeAt: new Date(now.getTime() + TRASH_RETENTION_MS),
	})
}

/**
 * Timestamp columns per kind. Rows come back from jsonb with ISO strings, but Drizzle's
 * timestamp columns expect Date objects on insert, so a restore revives exactly these
 * keys. An allowlist (rather than "convert anything that looks like a date") avoids
 * mangling a file name or skill body that happens to contain an ISO-looking string.
 */
const TIMESTAMP_KEYS: Record<TrashKind, readonly string[]> = {
	object: ['createdAt', 'updatedAt'],
	file: ['createdAt', 'updatedAt'],
	trigger: ['lastEscalatedAt', 'createdAt', 'updatedAt'],
	relationship: ['createdAt'],
	workspace_skill: ['createdAt', 'updatedAt'],
}

/** Return a copy of `row` with the given timestamp keys as Date objects. */
export function reviveDatesForKeys(
	keys: readonly string[],
	row: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...row }
	for (const key of keys) {
		const value = out[key]
		if (typeof value === 'string' && value.length > 0) {
			out[key] = new Date(value)
		}
	}
	return out
}

/** Return a copy of `row` with the kind's timestamp columns as Date objects. */
export function reviveDates(
	kind: TrashKind,
	row: Record<string, unknown>,
): Record<string, unknown> {
	return reviveDatesForKeys(TIMESTAMP_KEYS[kind], row)
}

/** Timestamp columns on an agent_skills attachment captured in a skill's `extra`. */
export const AGENT_SKILL_TIMESTAMP_KEYS = ['createdAt'] as const
