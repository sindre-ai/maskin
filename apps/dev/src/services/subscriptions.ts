import type { Database } from '@maskin/db'
import { events, actors, readState, subscriptions } from '@maskin/db/schema'
import { and, count, eq, gt, ne, sql } from 'drizzle-orm'

export type SubscriptionSource = 'manual' | 'author' | 'commenter' | 'mentioned'

export interface EntityRef {
	entityType: string
	entityId: string
}

export interface AutoSubscribeArgs extends EntityRef {
	workspaceId: string
	actorId: string
	source: SubscriptionSource
}

/**
 * Upsert a subscription row. The unique key is (actor_id, entity_type, entity_id);
 * on conflict we KEEP the existing source so manual/author are never downgraded by
 * a later auto-commenter subscribe.
 */
export async function autoSubscribe(db: Database, args: AutoSubscribeArgs): Promise<void> {
	await db
		.insert(subscriptions)
		.values({
			workspaceId: args.workspaceId,
			actorId: args.actorId,
			entityType: args.entityType,
			entityId: args.entityId,
			source: args.source,
		})
		.onConflictDoNothing({
			target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
		})
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

/** Whether the given actor has any subscription row for this entity. */
export async function isSubscribed(
	db: Database,
	args: { actorId: string } & EntityRef,
): Promise<boolean> {
	const [row] = await db
		.select({ id: subscriptions.id })
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.actorId, args.actorId),
				eq(subscriptions.entityType, args.entityType),
				eq(subscriptions.entityId, args.entityId),
			),
		)
		.limit(1)
	return Boolean(row)
}

export async function getSubscriberCount(
	db: Database,
	args: { workspaceId: string } & EntityRef,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.workspaceId, args.workspaceId),
				eq(subscriptions.entityType, args.entityType),
				eq(subscriptions.entityId, args.entityId),
			),
		)
	return row?.value ?? 0
}

export interface SubscriberRow {
	id: string
	type: string
	name: string
}

/** List subscribers (joined to actors for name/type — used by the avatar stack). */
export async function getSubscribers(
	db: Database,
	args: { workspaceId: string } & EntityRef,
): Promise<SubscriberRow[]> {
	return db
		.select({ id: actors.id, type: actors.type, name: actors.name })
		.from(subscriptions)
		.innerJoin(actors, eq(subscriptions.actorId, actors.id))
		.where(
			and(
				eq(subscriptions.workspaceId, args.workspaceId),
				eq(subscriptions.entityType, args.entityType),
				eq(subscriptions.entityId, args.entityId),
			),
		)
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

/** Remove the actor's manual subscription. */
export async function unsubscribe(
	db: Database,
	args: { actorId: string } & EntityRef,
): Promise<void> {
	await db
		.delete(subscriptions)
		.where(
			and(
				eq(subscriptions.actorId, args.actorId),
				eq(subscriptions.entityType, args.entityType),
				eq(subscriptions.entityId, args.entityId),
			),
		)
}
