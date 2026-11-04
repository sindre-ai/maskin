import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { OBJECT_DIFF_FIELDS, computeChanges } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { recordEvent } from './events/record-event'
import { logger } from './logger'
import { DELIVERED_ACTION, hasDelivered } from './object-delivery'

/**
 * A send tool that is given the task it carries out ends that task itself, so the workspace
 * never says "to do" about something already sent. Before this, closing the task was the
 * agent's job after the send, and a skipped or failed step left a to-do for a message that
 * had gone out. The next agent then drafted it again.
 *
 * Only `task` objects are moved. Their `done` status is the same in every workspace; other
 * types have their own status lists, so they get the `delivered` event and nothing else.
 */

/** Statuses a task is finished in. A send never moves a task out of one of these. */
const FINISHED_TASK_STATUSES: readonly string[] = ['done', 'validated', 'discarded']

export class SendTargetError extends Error {
	constructor(
		readonly code: 'NOT_FOUND' | 'ALREADY_SENT',
		message: string,
	) {
		super(message)
		this.name = 'SendTargetError'
	}
}

export interface SendTarget {
	id: string
	type: string
	status?: string
}

/**
 * Checks the object a send is for, before anything goes out: it must exist in the workspace
 * and must not already have been sent. Throws `SendTargetError` so the tool can say so
 * instead of sending a second time.
 */
export async function assertSendable(
	db: Database,
	params: { workspaceId: string; objectId: string },
): Promise<SendTarget> {
	const [row] = await db
		.select({ id: objects.id, type: objects.type, status: objects.status })
		.from(objects)
		.where(and(eq(objects.id, params.objectId), eq(objects.workspaceId, params.workspaceId)))
		.limit(1)
	if (!row) {
		throw new SendTargetError(
			'NOT_FOUND',
			'object_id does not match an object in this workspace. Nothing was sent.',
		)
	}
	if (await hasDelivered(db, params.workspaceId, row.id)) {
		throw new SendTargetError(
			'ALREADY_SENT',
			'This object was already sent. Nothing was sent again. Create a new task for a new message.',
		)
	}
	return row
}

export interface SendClosure {
	/** The `delivered` event was written on the object. */
	delivered: boolean
	/** The task moved to `done` by this send. False when it was not a task or was already finished. */
	task_closed: boolean
}

/**
 * Records the send on the object and, for a task, moves it to `done`. Call it after the
 * provider accepted the message. It never throws: the message is gone, so a bookkeeping
 * failure must not turn into an error the caller retries (which would send twice). A failed
 * attempt is logged and reported as `delivered: false`.
 */
export async function recordSendOutcome(
	db: Database,
	params: {
		workspaceId: string
		actorId: string
		target: SendTarget
		provider: string
		/** Written on the `delivered` event. Keep it to ids and timestamps, never message text. */
		data?: Record<string, unknown>
		/** Gmail records its own `delivered` event with the content hash; skip the second one. */
		skipDeliveredEvent?: boolean
	},
): Promise<SendClosure> {
	const { workspaceId, actorId, target } = params
	const result: SendClosure = { delivered: false, task_closed: false }
	try {
		if (!params.skipDeliveredEvent) {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: DELIVERED_ACTION,
				entityType: target.type,
				entityId: target.id,
				data: { provider: params.provider, ...params.data },
			})
		}
		result.delivered = true

		if (target.type !== 'task') return result

		await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(objects)
				.where(and(eq(objects.id, target.id), eq(objects.workspaceId, workspaceId)))
				.for('update')
				.limit(1)
			if (!current || FINISHED_TASK_STATUSES.includes(current.status)) return

			const [row] = await tx
				.update(objects)
				.set({ status: 'done', updatedAt: new Date() })
				.where(eq(objects.id, target.id))
				.returning()
			if (!row) return

			await recordEvent(tx, {
				workspaceId,
				actorId,
				action: 'status_changed',
				entityType: current.type,
				entityId: target.id,
				data: {
					changes: computeChanges(
						current as unknown as Record<string, unknown>,
						row as unknown as Record<string, unknown>,
						OBJECT_DIFF_FIELDS,
					),
					via: `${params.provider}_send`,
				},
			})
			result.task_closed = true
		})
	} catch (err) {
		logger.error('Message sent but the record of it failed', {
			workspaceId,
			objectId: target.id,
			provider: params.provider,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return result
}
