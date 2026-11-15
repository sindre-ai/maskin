import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	doneWhenLines,
	doneWhenSkips,
	objects,
	relationships,
} from '@maskin/db/schema'
import { TARGET_OF_RELATIONSHIP_TYPE, TARGET_TYPE } from '@maskin/ext-targets/shared'
import {
	DONE_WHEN_NO_SKIP_TYPES,
	type DoneWhenBlock,
	type DoneWhenResponse,
	type DoneWhenSkipResponse,
	type DoneWhenState,
	TERMINAL_STATUSES_BY_TYPE,
	parseCommentDecision,
} from '@maskin/shared'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { recordEvent } from './events/record-event'
import { GoAheadError, recordGoAhead } from './go-aheads'
import { logger } from './logger'

type LineRow = typeof doneWhenLines.$inferSelect

/** A write the caller got wrong or may not make. The route maps the code to a status. */
export class DoneWhenError extends Error {
	constructor(
		readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN',
		message: string,
	) {
		super(message)
		this.name = 'DoneWhenError'
	}
}

interface ObjectRef {
	id: string
	workspaceId: string
	type: string
	status: string | null
}

async function lockObject(tx: Transaction, objectId: string): Promise<ObjectRef> {
	const [object] = await tx
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			type: objects.type,
			status: objects.status,
		})
		.from(objects)
		.where(eq(objects.id, objectId))
		.for('update')
		.limit(1)
	if (!object) throw new DoneWhenError('NOT_FOUND', 'Object not found')
	return object
}

async function isHuman(tx: Transaction | Database, actorId: string): Promise<boolean> {
	const [actor] = await tx
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	return actor?.type === 'human'
}

function serialize(rows: LineRow[], approvedByName: string | null): DoneWhenResponse | null {
	const first = rows[0]
	if (!first) return null
	const approved = first.listStatus === 'approved'
	return {
		object_id: first.objectId,
		status: approved ? 'approved' : 'draft',
		version: first.version,
		approved_by: approved ? first.approvedBy : null,
		approved_by_name: approved ? approvedByName : null,
		approved_at: approved && first.approvedAt ? first.approvedAt.toISOString() : null,
		lines: rows.map((row) => ({
			id: row.id,
			position: row.position,
			text: row.text,
			checked_by: row.checkedBy as DoneWhenResponse['lines'][number]['checked_by'],
			needs_yes: row.needsYes,
			reading: row.reading,
			comparison: row.comparison,
			state: row.state as DoneWhenState,
			state_set_at: row.stateSetAt ? row.stateSetAt.toISOString() : null,
		})),
		true_count: rows.filter((row) => row.state === 'true').length,
		total: rows.length,
	}
}

/**
 * The job's current list: the approved one when there is one, else the draft. Null when the job
 * has none. Read straight from the table, no agent involved.
 */
export async function getDoneWhen(
	db: Database | Transaction,
	objectId: string,
): Promise<DoneWhenResponse | null> {
	const rows = await db
		.select()
		.from(doneWhenLines)
		.where(
			and(
				eq(doneWhenLines.objectId, objectId),
				inArray(doneWhenLines.listStatus, ['approved', 'draft']),
			),
		)
		.orderBy(asc(doneWhenLines.position))
	const approved = rows.filter((row) => row.listStatus === 'approved')
	const current = approved.length > 0 ? approved : rows
	const approverId = current[0]?.approvedBy
	let approverName: string | null = null
	if (approverId && current[0]?.listStatus === 'approved') {
		const [actor] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, approverId))
			.limit(1)
		approverName = actor?.name ?? null
	}
	return serialize(current, approverName)
}

/** True when the job already has an approved list: an agent may no longer rewrite it. */
export async function hasApprovedDoneWhen(
	db: Database | Transaction,
	objectId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: doneWhenLines.id })
		.from(doneWhenLines)
		.where(and(eq(doneWhenLines.objectId, objectId), eq(doneWhenLines.listStatus, 'approved')))
		.limit(1)
	return !!row
}

/**
 * Saves the lines of a decision card as the job's draft, replacing the earlier draft. Called in
 * the same transaction as the card. Never touches an approved list: the caller refuses first.
 */
export async function writeDraftDoneWhen(
	tx: Transaction,
	params: { workspaceId: string; objectId: string; actorId: string; block: DoneWhenBlock },
): Promise<void> {
	const { workspaceId, objectId, actorId, block } = params
	await tx
		.delete(doneWhenLines)
		.where(and(eq(doneWhenLines.objectId, objectId), eq(doneWhenLines.listStatus, 'draft')))
	await tx.insert(doneWhenLines).values(
		block.lines.map((line, index) => ({
			workspaceId,
			objectId,
			position: index,
			text: line.text,
			checkedBy: line.checked_by,
			needsYes: line.needs_yes ?? false,
			reading: line.checked_by === 'code' ? (line.reading ?? null) : null,
			comparison: line.checked_by === 'code' ? (line.comparison ?? null) : null,
			listStatus: 'draft',
			createdBy: actorId,
		})),
	)
}

/**
 * A person approving the draft by tapping Approve on its card. Written by the server in the same
 * transaction as the person's reply; no tool or route lets an agent do it. Also gives the
 * go-ahead for the lines that do not send, spend or delete, as a card grant by that person.
 * Returns false when there is no draft to approve (an old card tapped again).
 */
export async function approveDraftDoneWhen(
	tx: Transaction,
	params: { objectId: string; actorId: string },
): Promise<boolean> {
	if (!(await isHuman(tx, params.actorId))) {
		throw new DoneWhenError('FORBIDDEN', 'Only a person can approve a done-when list.')
	}
	const object = await lockObject(tx, params.objectId)
	const drafts = await tx
		.select({ id: doneWhenLines.id })
		.from(doneWhenLines)
		.where(and(eq(doneWhenLines.objectId, object.id), eq(doneWhenLines.listStatus, 'draft')))
	if (drafts.length === 0) return false

	await tx
		.update(doneWhenLines)
		.set({ listStatus: 'approved', approvedBy: params.actorId, approvedAt: new Date() })
		.where(and(eq(doneWhenLines.objectId, object.id), eq(doneWhenLines.listStatus, 'draft')))
	await recordEvent(tx, {
		workspaceId: object.workspaceId,
		actorId: params.actorId,
		action: 'done_when_approved',
		entityType: object.type,
		entityId: object.id,
		data: { lines: drafts.length },
	})

	// The tap is also the person's go-ahead. A closed job has none to give, and that is fine.
	const closed = (TERMINAL_STATUSES_BY_TYPE[object.type] ?? []).includes(object.status ?? '')
	if (!closed) {
		try {
			await recordGoAhead(tx, { objectId: object.id, actorId: params.actorId }, { via: 'card' })
		} catch (err) {
			if (!(err instanceof GoAheadError)) throw err
			logger.warn('go-ahead not recorded with done-when approval', { objectId: object.id })
		}
	}
	return true
}

/**
 * Sets one line's state. Only a person may, and only on an approved list: until the outcome check
 * lands, a tick is a person's reading, never an agent's.
 */
export async function setLineState(
	tx: Transaction,
	params: { lineId: string; actorId: string; state: DoneWhenState },
): Promise<DoneWhenResponse> {
	if (!(await isHuman(tx, params.actorId))) {
		throw new DoneWhenError('FORBIDDEN', 'Only a person can tick a line of the done-when list.')
	}
	const [line] = await tx
		.select()
		.from(doneWhenLines)
		.where(eq(doneWhenLines.id, params.lineId))
		.limit(1)
	if (!line) throw new DoneWhenError('NOT_FOUND', 'Line not found')
	if (line.listStatus !== 'approved') {
		throw new DoneWhenError('BAD_REQUEST', 'Only a line on an approved list can be ticked.')
	}
	await tx
		.update(doneWhenLines)
		.set({ state: params.state, stateSetAt: new Date(), stateSetBy: params.actorId })
		.where(eq(doneWhenLines.id, line.id))
	await recordEvent(tx, {
		workspaceId: line.workspaceId,
		actorId: params.actorId,
		action: 'done_when_line_set',
		entityType: 'object',
		entityId: line.objectId,
		data: { line_id: line.id, state: params.state },
	})
	const current = await getDoneWhen(tx, line.objectId)
	if (!current) throw new DoneWhenError('NOT_FOUND', 'Line not found')
	return current
}

/** Why a job may not skip its list, or null when it may. */
async function skipRefusal(tx: Transaction, object: ObjectRef): Promise<string | null> {
	if (
		(DONE_WHEN_NO_SKIP_TYPES as readonly string[]).includes(object.type) ||
		object.type === TARGET_TYPE
	) {
		return `A ${object.type} always gets a done-when list. Propose one with a decision card.`
	}
	const [edge] = await tx
		.select({ id: relationships.id })
		.from(relationships)
		.where(
			and(
				eq(relationships.type, TARGET_OF_RELATIONSHIP_TYPE),
				or(eq(relationships.sourceId, object.id), eq(relationships.targetId, object.id)),
			),
		)
		.limit(1)
	if (edge) {
		return 'A job with a target behind it always gets a done-when list. Propose one with a decision card.'
	}
	return null
}

/**
 * "List skipped, because X". The agent writes the reason, so the server decides who may skip: a
 * bet, a target or a job with a target behind it is refused. A refusal is logged outside the
 * rolled-back transaction so the skip rate and the refusals can both be counted.
 */
export async function skipDoneWhen(
	db: Database,
	params: { objectId: string; actorId: string; reason: string },
): Promise<DoneWhenSkipResponse> {
	let refusal: { workspaceId: string; type: string; message: string } | null = null
	try {
		return await db.transaction(async (tx) => {
			const object = await lockObject(tx, params.objectId)
			if (await hasApprovedOrDraft(tx, object.id)) {
				throw new DoneWhenError('BAD_REQUEST', 'This job already has a done-when list.')
			}
			const message = await skipRefusal(tx, object)
			if (message) {
				refusal = { workspaceId: object.workspaceId, type: object.type, message }
				throw new DoneWhenError('FORBIDDEN', message)
			}
			const [existing] = await tx
				.select()
				.from(doneWhenSkips)
				.where(eq(doneWhenSkips.objectId, object.id))
				.limit(1)
			const row =
				existing ??
				(
					await tx
						.insert(doneWhenSkips)
						.values({
							workspaceId: object.workspaceId,
							objectId: object.id,
							reason: params.reason,
							skippedBy: params.actorId,
						})
						.returning()
				)[0]
			if (!row) throw new Error('done-when skip insert returned no row')
			if (!existing) {
				await recordEvent(tx, {
					workspaceId: object.workspaceId,
					actorId: params.actorId,
					action: 'done_when_skipped',
					entityType: object.type,
					entityId: object.id,
					data: { reason_length: params.reason.length },
				})
			}
			return {
				object_id: row.objectId,
				reason: row.reason,
				skipped_by: row.skippedBy,
				skipped_at: row.skippedAt.toISOString(),
			}
		})
	} catch (err) {
		const refused = refusal as { workspaceId: string; type: string; message: string } | null
		if (refused) {
			try {
				await recordEvent(db, {
					workspaceId: refused.workspaceId,
					actorId: params.actorId,
					action: 'done_when_skip_refused',
					entityType: refused.type,
					entityId: params.objectId,
					data: {},
				})
			} catch (logErr) {
				logger.warn('done_when_skip_refused event failed', { error: String(logErr) })
			}
		}
		throw err
	}
}

async function hasApprovedOrDraft(tx: Transaction, objectId: string): Promise<boolean> {
	const [row] = await tx
		.select({ id: doneWhenLines.id })
		.from(doneWhenLines)
		.where(
			and(
				eq(doneWhenLines.objectId, objectId),
				inArray(doneWhenLines.listStatus, ['approved', 'draft']),
			),
		)
		.limit(1)
	return !!row
}

/**
 * A person's reply that picks the Approve option of a done-when card. Matches the way the other
 * card taps are read: the reply is the option's label, on a comment that carries a done_when
 * block, and the option has approve_done_when. Returns the object to approve the draft on.
 */
export async function resolveDoneWhenTap(
	db: Database,
	params: {
		workspaceId: string
		entityId: string
		parentEventId: number | undefined
		content: string
	},
): Promise<{ objectId: string } | null> {
	if (params.parentEventId === undefined) return null
	const reply = params.content.trim()
	if (!reply) return null
	const [card] = await db
		.select({ data: events.data })
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
	if (!decision?.done_when) return null
	const picked = decision.options.filter((o) => o.label.trim() === reply)
	if (picked.length !== 1 || !picked[0]?.approve_done_when) return null
	return { objectId: params.entityId }
}
