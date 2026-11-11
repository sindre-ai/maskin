import type { Transaction } from '@maskin/db'
import type { Database } from '@maskin/db'
import { events, actors, nextSteps, objects, sessions, workspaceMembers } from '@maskin/db/schema'
import type { NextStepResponse, SetNextStepInput, UpdateNextStepInput } from '@maskin/shared'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { recordEvent } from './events/record-event'

type NextStepRow = typeof nextSteps.$inferSelect

const LIVE_STATUSES = ['open', 'blocked'] as const

/** A write the caller got wrong or cannot make. The route maps the code to a status. */
export class NextStepError extends Error {
	constructor(
		readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT',
		message: string,
	) {
		super(message)
		this.name = 'NextStepError'
	}
}

export function serializeNextStep(row: NextStepRow): NextStepResponse {
	return {
		id: row.id,
		object_id: row.objectId,
		action: row.action,
		owner_id: row.ownerActorId,
		due_at: row.dueAt.toISOString(),
		status: row.status as NextStepResponse['status'],
		blocked_on_object_id: row.blockedOnObjectId,
		blocked_on_actor_id: row.blockedOnActorId,
		blocked_on_decision_comment_id: row.blockedOnDecisionCommentId,
		blocked_reason: row.blockedReason,
		evidence: row.evidence,
		wake_count: row.wakeCount,
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
		closed_at: row.closedAt ? row.closedAt.toISOString() : null,
	}
}

/** The object's open or blocked step, or null. */
export async function getLiveNextStep(
	db: Database | Transaction,
	objectId: string,
): Promise<NextStepRow | null> {
	const [row] = await db
		.select()
		.from(nextSteps)
		.where(and(eq(nextSteps.objectId, objectId), inArray(nextSteps.status, [...LIVE_STATUSES])))
		.limit(1)
	return row ?? null
}

interface BlockedOn {
	objectId: string | null
	actorId: string | null
	decisionCommentId: number | null
	reason: string | null
}

/** Exactly one blocked_on field, or none. Prose alone never counts as blocked. */
function readBlockedOn(input: {
	blocked_on_object_id?: string
	blocked_on_actor_id?: string
	blocked_on_decision_comment_id?: number
	blocked_reason?: string
}): BlockedOn | null {
	const given = [
		input.blocked_on_object_id,
		input.blocked_on_actor_id,
		input.blocked_on_decision_comment_id,
	].filter((v) => v !== undefined)
	if (given.length === 0) return null
	if (given.length > 1) {
		throw new NextStepError(
			'BAD_REQUEST',
			'A blocked step waits on exactly one thing: give one of blocked_on_object_id, blocked_on_actor_id or blocked_on_decision_comment_id',
		)
	}
	if (input.blocked_on_actor_id !== undefined && !input.blocked_reason) {
		throw new NextStepError(
			'BAD_REQUEST',
			'Blocked on an actor needs blocked_reason holding the question you are waiting on',
		)
	}
	return {
		objectId: input.blocked_on_object_id ?? null,
		actorId: input.blocked_on_actor_id ?? null,
		decisionCommentId: input.blocked_on_decision_comment_id ?? null,
		reason: input.blocked_reason ?? null,
	}
}

async function assertWorkspaceActor(
	tx: Transaction,
	workspaceId: string,
	actorId: string,
	label: string,
) {
	const [member] = await tx
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	if (!member) {
		throw new NextStepError('BAD_REQUEST', `${label} is not an agent or person in this workspace`)
	}
}

async function assertBlockedOnExists(
	tx: Transaction,
	object: { id: string; workspaceId: string },
	blockedOn: BlockedOn,
) {
	if (blockedOn.objectId) {
		if (blockedOn.objectId === object.id) {
			throw new NextStepError('BAD_REQUEST', 'An object cannot be blocked on itself')
		}
		const [found] = await tx
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.id, blockedOn.objectId), eq(objects.workspaceId, object.workspaceId)))
			.limit(1)
		if (!found)
			throw new NextStepError('BAD_REQUEST', 'blocked_on_object_id is not in this workspace')
	}
	if (blockedOn.actorId) {
		await assertWorkspaceActor(tx, object.workspaceId, blockedOn.actorId, 'blocked_on_actor_id')
	}
	if (blockedOn.decisionCommentId !== null) {
		const [found] = await tx
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.id, blockedOn.decisionCommentId),
					eq(events.workspaceId, object.workspaceId),
					eq(events.action, 'commented'),
				),
			)
			.limit(1)
		if (!found) {
			throw new NextStepError(
				'BAD_REQUEST',
				'blocked_on_decision_comment_id is not a comment in this workspace',
			)
		}
	}
}

function blockedColumns(blockedOn: BlockedOn | null) {
	return {
		blockedOnObjectId: blockedOn?.objectId ?? null,
		blockedOnActorId: blockedOn?.actorId ?? null,
		blockedOnDecisionCommentId: blockedOn?.decisionCommentId ?? null,
		blockedReason: blockedOn?.reason ?? null,
	}
}

/** Lock the driven object, so two writers on the same object take turns. */
async function lockObject(tx: Transaction, objectId: string) {
	const [object] = await tx
		.select({ id: objects.id, workspaceId: objects.workspaceId, type: objects.type })
		.from(objects)
		.where(eq(objects.id, objectId))
		.for('update')
		.limit(1)
	if (!object) throw new NextStepError('NOT_FOUND', 'Object not found')
	return object
}

/** The caller's session, if the header names a real one in this workspace; else null. */
async function knownSessionId(tx: Transaction, workspaceId: string, sessionId?: string | null) {
	if (!sessionId) return null
	const [found] = await tx
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)))
		.limit(1)
	return found?.id ?? null
}

interface WriteContext {
	objectId: string
	actorId: string
	sessionId?: string | null
}

/**
 * Give an object its next step. Refused while it already has an open or blocked one, unless
 * `replace` is set: the old step is then closed as skipped and the new one takes its place. One
 * transaction with the audit event on the driven object (caller's `tx`).
 */
export async function setNextStep(
	tx: Transaction,
	ctx: WriteContext,
	input: SetNextStepInput,
): Promise<NextStepRow> {
	const object = await lockObject(tx, ctx.objectId)
	const blockedOn = readBlockedOn(input)
	const ownerId = input.owner_id ?? ctx.actorId
	await assertWorkspaceActor(tx, object.workspaceId, ownerId, 'owner_id')
	if (blockedOn) await assertBlockedOnExists(tx, object, blockedOn)

	const now = new Date()
	const live = await getLiveNextStep(tx, object.id)
	if (live) {
		if (!input.replace) {
			throw new NextStepError(
				'CONFLICT',
				`This object already has a ${live.status} next step ("${live.action}", due ${live.dueAt.toISOString()}). Update or close it with update_next_step, or pass replace: true.`,
			)
		}
		await tx
			.update(nextSteps)
			.set({
				status: 'skipped',
				evidence: 'Replaced by a new next step',
				closedAt: now,
				updatedAt: now,
				...blockedColumns(null),
			})
			.where(eq(nextSteps.id, live.id))
	}

	const [row] = await tx
		.insert(nextSteps)
		.values({
			workspaceId: object.workspaceId,
			objectId: object.id,
			action: input.action,
			ownerActorId: ownerId,
			dueAt: new Date(input.due_at),
			status: blockedOn ? 'blocked' : 'open',
			...blockedColumns(blockedOn),
			createdBy: ctx.actorId,
			sessionId: await knownSessionId(tx, object.workspaceId, ctx.sessionId),
		})
		.returning()
	if (!row) throw new Error('next step insert returned no row')

	await recordEvent(tx, {
		workspaceId: object.workspaceId,
		actorId: ctx.actorId,
		action: 'next_step_set',
		entityType: object.type,
		entityId: object.id,
		data: {
			next_step_id: row.id,
			action: row.action,
			owner_id: row.ownerActorId,
			due_at: row.dueAt.toISOString(),
			status: row.status,
			replaced_next_step_id: live?.id ?? null,
		},
	})
	return row
}

/**
 * Change the object's current step, or close it (done or skipped, both with evidence). Moving
 * to blocked needs exactly one thing it waits on; moving back to open clears it.
 */
export async function updateNextStep(
	tx: Transaction,
	ctx: WriteContext,
	input: UpdateNextStepInput,
): Promise<NextStepRow> {
	const object = await lockObject(tx, ctx.objectId)
	const live = await getLiveNextStep(tx, object.id)
	if (!live) {
		throw new NextStepError(
			'NOT_FOUND',
			'This object has no open or blocked next step. Create one with set_next_step.',
		)
	}

	const blockedOn = readBlockedOn(input)
	if (blockedOn && input.status && input.status !== 'blocked') {
		throw new NextStepError(
			'BAD_REQUEST',
			`A blocked_on field only goes with status blocked, not ${input.status}`,
		)
	}
	const status = input.status ?? (blockedOn ? 'blocked' : (live.status as 'open' | 'blocked'))
	const closing = status === 'done' || status === 'skipped'
	if (closing && !input.evidence) {
		throw new NextStepError(
			'BAD_REQUEST',
			status === 'done'
				? 'Closing a step as done needs evidence: what shows it is done'
				: 'Closing a step as skipped needs evidence: why it was skipped',
		)
	}
	if (status === 'blocked' && !blockedOn && live.status !== 'blocked') {
		throw new NextStepError(
			'BAD_REQUEST',
			'A blocked step waits on exactly one thing: give one of blocked_on_object_id, blocked_on_actor_id or blocked_on_decision_comment_id',
		)
	}
	if (blockedOn) await assertBlockedOnExists(tx, object, blockedOn)
	if (input.owner_id) {
		await assertWorkspaceActor(tx, object.workspaceId, input.owner_id, 'owner_id')
	}

	// Blocked keeps what it waits on unless a new one is given; every other state clears it.
	let blocked: ReturnType<typeof blockedColumns>
	if (status === 'blocked') {
		blocked = blockedOn
			? blockedColumns(blockedOn)
			: {
					blockedOnObjectId: live.blockedOnObjectId,
					blockedOnActorId: live.blockedOnActorId,
					blockedOnDecisionCommentId: live.blockedOnDecisionCommentId,
					blockedReason: input.blocked_reason ?? live.blockedReason,
				}
	} else {
		blocked = blockedColumns(null)
	}

	const now = new Date()
	const [row] = await tx
		.update(nextSteps)
		.set({
			status,
			action: input.action ?? live.action,
			ownerActorId: input.owner_id ?? live.ownerActorId,
			dueAt: input.due_at ? new Date(input.due_at) : live.dueAt,
			evidence: input.evidence ?? live.evidence,
			closedAt: closing ? now : null,
			updatedAt: now,
			...blocked,
		})
		.where(eq(nextSteps.id, live.id))
		.returning()
	if (!row) throw new Error('next step update returned no row')

	await recordEvent(tx, {
		workspaceId: object.workspaceId,
		actorId: ctx.actorId,
		action: closing ? 'next_step_closed' : 'next_step_updated',
		entityType: object.type,
		entityId: object.id,
		data: {
			next_step_id: row.id,
			action: row.action,
			owner_id: row.ownerActorId,
			due_at: row.dueAt.toISOString(),
			status: row.status,
			previous_status: live.status,
			evidence: closing ? row.evidence : null,
		},
	})
	return row
}

/**
 * The first list of driven objects that must always have a next step: bets in active, loops in
 * pilot, supervised or live, events in planned, in_production or live. Tasks, contacts, content
 * and insights are out: a task already has an automatic owner through its status triggers.
 */
export const NEXT_STEP_COVERED_OBJECTS: ReadonlyArray<{
	type: string
	statuses: readonly string[]
}> = [
	{ type: 'bet', statuses: ['active'] },
	{ type: 'loop', statuses: ['pilot', 'supervised', 'live'] },
	{ type: 'event', statuses: ['planned', 'in_production', 'live'] },
]

/** Slack before a step counts as overdue, so a step due this minute is not flagged. */
export const NEXT_STEP_OVERDUE_GRACE_MS = 5 * 60 * 1000

export interface ObjectNeedingNextStep {
	objectId: string
	workspaceId: string
	type: string
	status: string
	driverId: string
	/** overdue: the open step is past due. missing: the object has no open or blocked step. */
	reason: 'overdue' | 'missing'
	nextStepId: string | null
	dueAt: Date | null
}

/**
 * One query: every covered object driven by an agent that has an overdue open step or no step
 * at all. A blocked step is never overdue, it is waiting on something named. Read-only; the
 * sweep decides what to do with the rows.
 */
export async function findObjectsNeedingNextStep(
	db: Database,
	opts: { workspaceId?: string; now?: Date; notUpdatedSince?: Date; limit?: number } = {},
): Promise<ObjectNeedingNextStep[]> {
	const now = opts.now ?? new Date()
	const overdueBefore = new Date(now.getTime() - NEXT_STEP_OVERDUE_GRACE_MS)
	const covered = or(
		...NEXT_STEP_COVERED_OBJECTS.map((c) =>
			and(eq(objects.type, c.type), inArray(objects.status, [...c.statuses])),
		),
	)

	const rows = await db
		.select({
			objectId: objects.id,
			workspaceId: objects.workspaceId,
			type: objects.type,
			status: objects.status,
			driverId: actors.id,
			nextStepId: nextSteps.id,
			dueAt: nextSteps.dueAt,
		})
		.from(objects)
		.innerJoin(actors, and(eq(actors.id, objects.driver), eq(actors.type, 'agent')))
		.leftJoin(
			nextSteps,
			and(eq(nextSteps.objectId, objects.id), inArray(nextSteps.status, [...LIVE_STATUSES])),
		)
		.where(
			and(
				covered,
				opts.workspaceId ? eq(objects.workspaceId, opts.workspaceId) : undefined,
				opts.notUpdatedSince ? lt(objects.updatedAt, opts.notUpdatedSince) : undefined,
				or(
					isNull(nextSteps.id),
					and(eq(nextSteps.status, 'open'), lt(nextSteps.dueAt, overdueBefore)),
				),
			),
		)
		.limit(opts.limit ?? 500)

	return rows.map((r) => ({
		objectId: r.objectId,
		workspaceId: r.workspaceId,
		type: r.type,
		status: r.status,
		driverId: r.driverId,
		reason: r.nextStepId ? 'overdue' : 'missing',
		nextStepId: r.nextStepId,
		dueAt: r.dueAt,
	}))
}
