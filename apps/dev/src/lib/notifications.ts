import type { Transaction } from '@maskin/db'
import { events, notifications } from '@maskin/db/schema'

export type NewNotification = typeof notifications.$inferInsert
export type Notification = typeof notifications.$inferSelect

/**
 * Batch-inserts notification rows, then inserts a matching
 * `entityType: 'notification', action: 'created'` audit event for each
 * created row. Every notification fan-out path (agent @-mention
 * notifications, bet terminal-status notifications, ...) needs this same
 * "insert notifications, then log an audit event per row" pair — centralized
 * here so the two writes can't drift apart across call sites.
 *
 * Must run inside the same transaction as the mutation that triggered the
 * notifications, so a failure here rolls back the triggering write too.
 */
export async function insertNotificationsWithEvents(
	tx: Transaction,
	args: { workspaceId: string; actorId: string; rows: NewNotification[] },
): Promise<Notification[]> {
	const { workspaceId, actorId, rows } = args
	if (rows.length === 0) return []

	const created = await tx.insert(notifications).values(rows).returning()

	if (created.length > 0) {
		await tx.insert(events).values(
			created.map((n) => ({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'notification',
				entityId: n.id,
				data: n,
			})),
		)
	}

	return created
}
