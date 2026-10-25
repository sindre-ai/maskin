/**
 * Pieces shared by the briefing and lifecycle push schedulers. Both turn a decision into ONE
 * `notifications` row (inserted with its audit event) that the existing push fan-out
 * (`notification-push.ts` + `push-policy.ts`) delivers, so quiet hours, category toggles,
 * muted workspaces and rate limits are enforced there and not repeated here.
 */
import type { Database, Transaction } from '@maskin/db'
import { actors, deviceTokens, webPushSubscriptions, workspaceMembers } from '@maskin/db/schema'
import { type SQL, and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { insertNotificationsWithEvents } from '../lib/notifications'

/** `actorColumn IN (actors with an APNs device or a Web Push subscription)`. Not correlated. */
export function hasPushDevice(db: Database, actorColumn: Parameters<typeof inArray>[0]): SQL {
	return or(
		inArray(actorColumn, db.select({ id: deviceTokens.actorId }).from(deviceTokens)),
		inArray(
			actorColumn,
			db.select({ id: webPushSubscriptions.actorId }).from(webPushSubscriptions),
		),
	) as SQL
}

/**
 * Who a scheduler-made notification comes from. The push fan-out ignores a notification whose
 * source is its own target, and `notifications.source_actor_id` is NOT NULL, so it needs a
 * non-human member of the workspace: "Chief of Staff" first, then a system actor, then any
 * other agent. Null when the workspace has none (the caller skips rather than invent one).
 */
export async function resolveSourceActor(
	db: Database,
	workspaceId: string,
	targetActorId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				ne(actors.id, targetActorId),
				ne(actors.type, 'human'),
			),
		)
		.orderBy(
			desc(sql`${actors.name} = 'Chief of Staff'`),
			desc(actors.isSystem),
			asc(actors.createdAt),
			asc(actors.id),
		)
		.limit(1)
	return row?.id ?? null
}

export interface PushNotificationInput {
	workspaceId: string
	sourceActorId: string
	targetActorId: string
	title: string
	body: string | null
	objectId?: string | null
	sessionId?: string | null
	/** Merged over the push contract fields below. */
	metadata: Record<string, unknown>
	pushCategory: 'digest' | 'tips'
	collapseKey: string
}

/** Insert the notification row + audit event; `push_force` is what lets digest/tips push. */
export async function insertPushNotification(tx: Transaction, input: PushNotificationInput) {
	const [row] = await insertNotificationsWithEvents(tx, {
		workspaceId: input.workspaceId,
		actorId: input.sourceActorId,
		rows: [
			{
				workspaceId: input.workspaceId,
				// 'recommendation' is the least misleading of the four existing types: not
				// 'needs_input' (it must not count as a pending ask or flip the badge into
				// "needs you"), not 'good_news'/'alert' (a briefing can carry neither).
				type: 'recommendation',
				title: input.title,
				content: input.body,
				sourceActorId: input.sourceActorId,
				targetActorId: input.targetActorId,
				objectId: input.objectId ?? null,
				sessionId: input.sessionId ?? null,
				status: 'pending',
				metadata: {
					...input.metadata,
					push_category: input.pushCategory,
					push_force: true,
					push_collapse_key: input.collapseKey,
				},
			},
		],
	})
	return row ?? null
}
