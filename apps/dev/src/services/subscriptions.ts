import type { Database } from '@maskin/db'
import { events, readState } from '@maskin/db/schema'
import { and, count, eq, gt, ne, sql } from 'drizzle-orm'

export interface EntityRef {
	entityType: string
	entityId: string
}

/**
 * Compute unread comment count for (actor, entity). Excludes the actor's own
 * comments — you don't notify yourself about what you typed.
 */
export async function getUnreadCount(
	db: Database,
	args: { workspaceId: string; actorId: string } & EntityRef,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, args.workspaceId),
				eq(events.entityType, args.entityType),
				eq(events.entityId, args.entityId),
				eq(events.action, 'commented'),
				ne(events.actorId, args.actorId),
				gt(
					events.id,
					sql`coalesce((select last_read_event_id from read_state where actor_id = ${args.actorId} and entity_type = ${args.entityType} and entity_id = ${args.entityId}), 0)`,
				),
			),
		)
	return row?.value ?? 0
}

/**
 * Upsert read state — never moves backward. `last_read_event_id` is the
 * highest event id the actor has seen (events.id is a monotonic bigserial).
 */
export async function markRead(
	db: Database,
	args: { workspaceId: string; actorId: string; lastReadEventId: number } & EntityRef,
): Promise<void> {
	await db
		.insert(readState)
		.values({
			workspaceId: args.workspaceId,
			actorId: args.actorId,
			entityType: args.entityType,
			entityId: args.entityId,
			lastReadEventId: args.lastReadEventId,
		})
		.onConflictDoUpdate({
			target: [readState.actorId, readState.entityType, readState.entityId],
			set: {
				lastReadEventId: sql`greatest(${readState.lastReadEventId}, excluded.last_read_event_id)`,
				lastReadAt: new Date(),
			},
		})
}

/**
 * Slack-style toggle back to unread: delete the actor's read_state row for
 * this entity so every event with id > 0 counts as unread again on the next
 * read of the unread feed / detail. Idempotent — no row is a no-op.
 */
export async function markUnread(
	db: Database,
	args: { actorId: string } & EntityRef,
): Promise<void> {
	await db
		.delete(readState)
		.where(
			and(
				eq(readState.actorId, args.actorId),
				eq(readState.entityType, args.entityType),
				eq(readState.entityId, args.entityId),
			),
		)
}
