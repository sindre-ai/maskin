import type { Database, Transaction } from '@maskin/db'
import { events, objects, workspaces } from '@maskin/db/schema'
import {
	type CommentDecision,
	type DecisionProseViolation,
	findStatusActionViolations,
	parseCommentDecision,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { applyObjectUpdate } from './object-update'
import type { WorkspaceSettings } from './types'

/**
 * Status changes made from a For You decision card.
 *
 * An option with `set_status` is a button that moves an object. Posting the card stamps the
 * status the object was in; the For You list drops the card once the object leaves it, and a
 * tap changes the status only while it is still there, so an old card tapped later cannot pull
 * a bet backwards.
 */

export interface StatusActionTarget {
	id: string
	type: string
	status: string | null
}

async function statusesOfType(
	db: Database,
	workspaceId: string,
	type: string,
): Promise<string[] | undefined> {
	const [workspace] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	return (workspace?.settings as WorkspaceSettings | null)?.statuses?.[type]
}

/**
 * Checks a new decision against the object it is posted on and stamps it. Returns the violations
 * (the card must not be posted) or the decision to store.
 */
export async function prepareStatusActions(
	db: Database,
	params: { workspaceId: string; object: { id: string; type: string }; decision: CommentDecision },
): Promise<{ violations: DecisionProseViolation[] } | { decision: CommentDecision }> {
	const { workspaceId, object, decision } = params
	// Whatever the agent sent in the stamp is replaced, or removed when there is no action.
	const { status_stamp: _ignored, ...rest } = decision
	const actions = rest.options.flatMap((option, index) =>
		option.set_status ? [{ index, ...option.set_status }] : [],
	)

	if (actions.length === 0) {
		const statuses = await statusesOfType(db, workspaceId, object.type)
		const violations = statuses ? findStatusActionViolations(rest, statuses) : []
		return violations.length > 0 ? { violations } : { decision: rest }
	}

	const targetIds = new Set(actions.map((a) => a.object_id ?? object.id))
	if (targetIds.size > 1) {
		return {
			violations: [
				{
					path: 'options',
					message:
						'Every set_status option on one card must move the same object, because the card drops when that object changes status. Use one card per object.',
				},
			],
		}
	}
	const targetId = [...targetIds][0] as string
	const [target] = await db
		.select({ id: objects.id, type: objects.type, status: objects.status })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, targetId)))
		.limit(1)
	if (!target) {
		return {
			violations: actions.map((a) => ({
				path: `options.${a.index}.set_status.object_id`,
				message: `No object ${targetId} in this workspace.`,
			})),
		}
	}

	const valid = await statusesOfType(db, workspaceId, target.type)
	const violations: DecisionProseViolation[] = []
	for (const action of actions) {
		const path = `options.${action.index}.set_status.status`
		if (valid && !valid.includes(action.status)) {
			violations.push({
				path,
				message: `"${action.status}" is not a status of a ${target.type}. Valid: ${valid.join(', ')}.`,
			})
		} else if (action.status === target.status) {
			violations.push({
				path,
				message: `The ${target.type} is already "${action.status}", so there is nothing to ask. Check the live status before posting the card.`,
			})
		}
	}
	if (violations.length > 0) return { violations }

	return {
		decision: { ...rest, status_stamp: { object_id: target.id, status: target.status ?? '' } },
	}
}

/** The option a person's reply picked, when it carries a status change on a stamped card. */
export interface StatusTap {
	cardEventId: number
	objectId: string
	status: string
	/** The status the object had when the card was posted. */
	stampedStatus: string
}

export async function resolveStatusTap(
	db: Database,
	params: {
		workspaceId: string
		entityId: string
		parentEventId: number | undefined
		content: string
	},
): Promise<StatusTap | null> {
	if (params.parentEventId === undefined) return null
	const reply = params.content.trim()
	if (!reply) return null

	const [card] = await db
		.select({ id: events.id, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, params.parentEventId),
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityId, params.entityId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	const decision = parseCommentDecision((card?.data as { decision?: unknown } | null)?.decision)
	if (!card || !decision?.status_stamp) return null

	const picked = decision.options.filter((o) => o.label.trim() === reply)
	const status = picked.length === 1 ? picked[0]?.set_status : undefined
	if (!status) return null
	const objectId = status.object_id ?? params.entityId
	if (objectId !== decision.status_stamp.object_id) return null
	return {
		cardEventId: Number(card.id),
		objectId,
		status: status.status,
		stampedStatus: decision.status_stamp.status,
	}
}

export type StatusActionResult =
	| { applied: true; object_id: string; status: string }
	| {
			applied: false
			object_id: string
			reason: 'moved_on' | 'not_found' | 'invalid_status'
			current_status: string | null
	  }

/**
 * Makes the status change a tap asked for, as the person who tapped, through the same write as
 * their own click on the object (the caller has already checked they may write). Does nothing when the object is not in the status the card was
 * written about, and says so.
 */
export async function applyStatusTap(
	tx: Transaction,
	params: {
		tap: StatusTap
		workspaceId: string
		actorId: string
		sessionId?: string
	},
): Promise<StatusActionResult> {
	const { tap, workspaceId, actorId } = params
	const [target] = await tx
		.select({ id: objects.id, type: objects.type, status: objects.status })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, tap.objectId)))
		.limit(1)
	if (!target) {
		return { applied: false, object_id: tap.objectId, reason: 'not_found', current_status: null }
	}
	const none = { applied: false as const, object_id: tap.objectId, current_status: target.status }

	const valid = await statusesOfType(tx as unknown as Database, workspaceId, target.type)
	if (valid && !valid.includes(tap.status)) return { ...none, reason: 'invalid_status' }

	const result = await applyObjectUpdate(tx, {
		id: tap.objectId,
		actorId,
		body: { status: tap.status },
		sessionId: params.sessionId,
		onlyIfStatus: tap.stampedStatus,
	})
	if (result.row) return { applied: true, object_id: tap.objectId, status: result.row.status }
	return {
		...none,
		reason: result.staleStatus === undefined ? 'not_found' : 'moved_on',
		current_status: result.staleStatus ?? null,
	}
}
