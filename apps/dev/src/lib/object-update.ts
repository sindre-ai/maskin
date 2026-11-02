import type { Transaction } from '@maskin/db'
import { objects, subscriptions, triggers } from '@maskin/db/schema'
import {
	OBJECT_DIFF_FIELDS,
	TERMINAL_BET_STATUSES,
	computeChanges,
	type updateObjectSchema,
} from '@maskin/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { z } from 'zod'
import { recordEvent } from './events/record-event'
import { logger } from './logger'
import { insertNotificationsWithEvents } from './notifications'

type ObjectUpdate = z.infer<typeof updateObjectSchema>

export interface ApplyObjectUpdateInput {
	id: string
	actorId: string
	body: ObjectUpdate
	sessionId?: string
	/** Apply only if the object is still in this status, checked under the row lock. */
	onlyIfStatus?: string
}

export interface ApplyObjectUpdateResult {
	/** The updated row; unset when the object is gone or `onlyIfStatus` did not hold. */
	row?: typeof objects.$inferSelect
	/** Set when `onlyIfStatus` did not hold: the status the object is in now. */
	staleStatus?: string | null
}

/**
 * The write behind PATCH /objects/{id}: the update, its status_changed / updated event, the
 * bet-terminal notification fan-out and the loop trigger pause, all in the caller's
 * transaction so a fan-out failure cannot leave the object updated but watchers un-notified.
 * The route and a status change made from a For You card both go through here, so transition
 * side effects and triggers run the same either way. Workspace status validation stays with
 * the caller.
 */
export async function applyObjectUpdate(
	tx: Transaction,
	input: ApplyObjectUpdateInput,
): Promise<ApplyObjectUpdateResult> {
	const { id, actorId, body, sessionId } = input
	const updateData: ObjectUpdate & { updatedAt: Date } = { ...body, updatedAt: new Date() }

	// Re-read the row under FOR UPDATE *inside* the transaction rather than
	// trusting the pre-transaction `existing` fetch above. `existing` is only
	// safe to use for the 404/validation checks that already returned by this
	// point — using it here would be a stale read: two concurrent PATCHes that
	// both flip the same bet to a terminal status would both see the same
	// pre-transition `existing.status` and both fan out duplicate
	// notifications. The row lock makes the second PATCH block until the
	// first commits, then observe the now-terminal status and correctly skip
	// the fan-out.
	const [current] = await tx.select().from(objects).where(eq(objects.id, id)).for('update').limit(1)
	if (!current) return {}

	// A status change made from an answer to a card: the card was written about one status, so
	// if the object has moved on since, leave it where it is.
	if (input.onlyIfStatus !== undefined && current.status !== input.onlyIfStatus) {
		return { staleStatus: current.status }
	}

	// Shallow-merge metadata against the locked row, not the pre-transaction
	// read: a writer that committed between that read and the lock would
	// otherwise have its keys overwritten with stale values. New fields are
	// added/overwritten, existing fields are preserved; with no stored
	// metadata the body metadata is written as is.
	if (body.metadata && current.metadata) {
		updateData.metadata = {
			...(current.metadata as typeof body.metadata),
			...body.metadata,
		}
	}

	const [row] = await tx.update(objects).set(updateData).where(eq(objects.id, id)).returning()
	if (!row) return {}

	// Derive action inside the transaction from the locked pre-update read so
	// the event record is accurate even under concurrent PATCHes.
	const action = current.status !== row.status ? 'status_changed' : 'updated'

	// Log a per-field diff instead of full pre/post snapshots. On a 100 KB-content
	// bet, a title-only edit now ships ~200 B of event payload instead of ~200 KB —
	// see bet/mcp-response-shape AC #4.
	const changes = computeChanges(
		current as unknown as Record<string, unknown>,
		row as unknown as Record<string, unknown>,
		OBJECT_DIFF_FIELDS,
	)
	await recordEvent(tx, {
		workspaceId: current.workspaceId,
		actorId,
		action,
		entityType: current.type,
		entityId: id,
		data: { changes },
		provenance: { sessionId, entityKind: 'object' },
	})

	// Fan out a notification row to every subscriber when a bet reaches a
	// terminal state (succeeded/failed/paused — see TERMINAL_BET_STATUSES).
	// The status_changed event itself surfaces the entity in the unread feed
	// (see subscriptions.ts); the notification row drives the dedicated
	// terminal-signal UI and is the canonical record for "watcher was told
	// the bet ended". Author/manual/commenter/mentioned subscribers are all
	// included; the actor making the change is excluded (you don't notify
	// yourself about your own flip).
	//
	// Guard on current.status not already being terminal: prevents a re-PATCH
	// of an already-terminal bet from double-notifying subscribers.
	if (
		action === 'status_changed' &&
		current.type === 'bet' &&
		isTerminalBetStatus(row.status) &&
		!isTerminalBetStatus(current.status)
	) {
		await fanOutBetTerminalNotifications(tx, {
			workspaceId: current.workspaceId,
			actorId,
			bet: row,
		})
	}

	// Pausing a loop must pause its work: every trigger referenced in the
	// loop's metadata.trigger_ids stops firing while the loop is paused, and
	// resumes when the loop leaves paused. This PATCH is the single choke
	// point for loop status writes — the frontend's pause/resume button and
	// the MCP update_loop tool both land here — so it's implemented once
	// rather than duplicated per caller.
	if (action === 'status_changed' && current.type === 'loop') {
		const enteringPaused = row.status === 'paused' && current.status !== 'paused'
		const leavingPaused = current.status === 'paused' && row.status !== 'paused'
		if (enteringPaused || leavingPaused) {
			const meta = (row.metadata as Record<string, unknown> | null) ?? {}
			const rawTriggerIds = meta.trigger_ids
			const triggerIds = Array.isArray(rawTriggerIds)
				? rawTriggerIds.filter((v): v is string => typeof v === 'string')
				: []
			if (triggerIds.length > 0) {
				await tx
					.update(triggers)
					.set({ enabled: leavingPaused, updatedAt: new Date() })
					.where(
						and(eq(triggers.workspaceId, current.workspaceId), inArray(triggers.id, triggerIds)),
					)
			}
		}
	}

	return { row }
}

function isTerminalBetStatus(status: string): boolean {
	return (TERMINAL_BET_STATUSES as readonly string[]).includes(status)
}

function betTerminalNotificationContent(bet: typeof objects.$inferSelect): {
	type: 'good_news' | 'alert'
	title: string
} {
	switch (bet.status) {
		case 'succeeded':
			return { type: 'good_news', title: `Bet succeeded: ${bet.title}` }
		case 'paused':
			return { type: 'alert', title: `Bet paused: ${bet.title}` }
		default:
			return { type: 'alert', title: `Bet failed: ${bet.title}` }
	}
}

async function fanOutBetTerminalNotifications(
	tx: Transaction,
	args: { workspaceId: string; actorId: string; bet: typeof objects.$inferSelect },
): Promise<void> {
	const { workspaceId, actorId, bet } = args

	const subs = await tx
		.select({ actorId: subscriptions.actorId })
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.workspaceId, workspaceId),
				eq(subscriptions.entityType, 'object'),
				eq(subscriptions.entityId, bet.id),
				ne(subscriptions.actorId, actorId),
			),
		)

	if (subs.length === 0) {
		logger.info('Bet reached terminal state, no subscribers to notify', {
			betId: bet.id,
			status: bet.status,
		})
		return
	}

	const { type, title } = betTerminalNotificationContent(bet)

	const created = await insertNotificationsWithEvents(tx, {
		workspaceId,
		actorId,
		rows: subs.map((s) => ({
			workspaceId,
			type,
			title,
			content: null,
			sourceActorId: actorId,
			targetActorId: s.actorId,
			objectId: bet.id,
			status: 'pending' as const,
		})),
	})

	logger.info('Bet reached terminal state, notified subscribers', {
		betId: bet.id,
		status: bet.status,
		notified: created.length,
	})
}
