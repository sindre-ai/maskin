import type { Transaction } from '@maskin/db'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	nextSteps,
	objects,
	relationships,
	sessions,
	triggers,
	workspaceMembers,
} from '@maskin/db/schema'
import { MIN_WAKE_LEAD_MINUTES } from '@maskin/shared'
import type {
	NextStepResponse,
	ScheduleNextStepInput,
	ScheduleNextStepResponse,
	SetNextStepInput,
	UpdateNextStepInput,
} from '@maskin/shared'
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
 * Delete the wake-up pinned to a step, so a closed or replaced step is never woken for. The
 * delete event is what tells the trigger runner to drop its timer. A reminder that already fired
 * is deleted too: it has nothing left to do.
 */
async function cancelWake(tx: Transaction, ctx: WriteContext, step: NextStepRow) {
	if (!step.wakeTriggerId) return
	const [gone] = await tx
		.delete(triggers)
		.where(eq(triggers.id, step.wakeTriggerId))
		.returning({ id: triggers.id, name: triggers.name, workspaceId: triggers.workspaceId })
	if (!gone) return
	await recordEvent(tx, {
		workspaceId: gone.workspaceId,
		actorId: ctx.actorId,
		action: 'deleted',
		entityType: 'trigger',
		entityId: gone.id,
		data: { trigger_name: gone.name, type: 'reminder', cascade: 'next_step_closed' },
	})
}

/**
 * Bring the step's wake-up in line with the step. A new time also switches it back on if it had
 * already gone off; a new action rewrites the prompt it will wake the owner with.
 */
async function syncWake(
	tx: Transaction,
	ctx: WriteContext,
	step: NextStepRow,
	change: { dueAt?: Date; action?: string },
) {
	if (!step.wakeTriggerId) return
	const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, step.wakeTriggerId))
	if (!trigger || trigger.type !== 'reminder') return
	await tx
		.update(triggers)
		.set({
			...(change.dueAt
				? {
						config: {
							...(trigger.config as Record<string, unknown>),
							scheduled_at: change.dueAt.toISOString(),
						},
						enabled: true,
					}
				: {}),
			...(change.action
				? { name: wakeName(change.action), actionPrompt: wakePrompt(change.action) }
				: {}),
			updatedAt: new Date(),
		})
		.where(eq(triggers.id, trigger.id))
	await recordEvent(tx, {
		workspaceId: trigger.workspaceId,
		actorId: ctx.actorId,
		action: 'updated',
		entityType: 'trigger',
		entityId: trigger.id,
		data: { trigger_name: trigger.name, type: trigger.type },
	})
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
				`This object already has ${live.status === 'open' ? 'an open' : 'a blocked'} next step ("${live.action}", due ${live.dueAt.toISOString()}). Update or close it with update_next_step, or pass replace: true.`,
			)
		}
		await cancelWake(tx, ctx, live)
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
		// The wake-up is set for the owner, so a new owner would leave the old one woken and the
		// new one not. Handing a step on is a new schedule, not an edit.
		if (input.owner_id !== live.ownerActorId && live.wakeTriggerId) {
			const [wake] = await tx
				.select({ id: triggers.id })
				.from(triggers)
				.where(eq(triggers.id, live.wakeTriggerId))
				.limit(1)
			if (wake) {
				throw new NextStepError(
					'CONFLICT',
					'This step has a wake-up set for its current owner, so the owner cannot be changed here. Use schedule_next_step with replace: true and the new owner_id: it cancels the old wake-up and sets up the right one.',
				)
			}
		}
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

	// The wake-up follows the step: closing cancels it, a new time or coming back from blocked
	// moves it, a new action rewrites its prompt.
	if (closing) {
		await cancelWake(tx, ctx, live)
	} else {
		const timeMoved = status === 'open' && (Boolean(input.due_at) || live.status === 'blocked')
		const actionChanged = row.action !== live.action
		if (timeMoved || actionChanged) {
			await syncWake(tx, ctx, live, {
				dueAt: timeMoved ? row.dueAt : undefined,
				action: actionChanged ? row.action : undefined,
			})
		}
	}

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

const WAKE_PROMPT_LATE_LINE =
	'If this session starts more than 1 hour after the time above, do nothing: the step stays open and the sweep handles it.'

const CHILD_TASK_TITLE_MAX_CHARS = 80

export interface ScheduleContext extends WriteContext {
	/** From assertScheduledWorkWithinCap: set when the calling run started on its own. */
	createdFromStartReason: string | null
}

const wakeName = (action: string) => `Next step: ${childTaskTitle(action)}`

const wakePrompt = (action: string) =>
	`Your next step is due: ${action}\n\nDo it, then close the step with update_next_step (done, with the result as evidence) and set the following one with schedule_next_step. If it cannot be done, say why and close it as skipped. ${WAKE_PROMPT_LATE_LINE}`

/** A task title is a short label; the action can be a full sentence. */
function childTaskTitle(action: string) {
	const oneLine = action.replace(/\s+/g, ' ').trim()
	return oneLine.length <= CHILD_TASK_TITLE_MAX_CHARS
		? oneLine
		: `${oneLine.slice(0, CHILD_TASK_TITLE_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * Set the next step and make sure someone comes back for it, in one transaction. Who is woken
 * depends on the owner:
 *  - the caller (an agent): a one-off reminder for them, pinned to this object and step;
 *  - another agent: a task with that agent as driver, and the step waits on that task. The wake is
 *    the child task closing, not a timer;
 *  - a person: the step is stored and nobody is woken.
 * The pending-wake cap is checked by the caller before this runs (it needs the HTTP context).
 */
export async function scheduleNextStep(
	tx: Transaction,
	ctx: ScheduleContext,
	input: ScheduleNextStepInput,
): Promise<{ step: NextStepRow; wakeUp: ScheduleNextStepResponse['wake_up'] }> {
	const object = await lockObject(tx, ctx.objectId)
	const ownerId = input.owner_id ?? ctx.actorId
	await assertWorkspaceActor(tx, object.workspaceId, ownerId, 'owner_id')
	const [owner] = await tx
		.select({ id: actors.id, type: actors.type, name: actors.name })
		.from(actors)
		.where(eq(actors.id, ownerId))
	if (!owner) throw new NextStepError('BAD_REQUEST', 'owner_id is not an agent or person')

	const base = { action: input.action, due_at: input.due_at, replace: input.replace }
	const now = new Date()
	const dueAt = new Date(input.due_at)

	if (owner.type !== 'agent') {
		const step = await setNextStep(tx, ctx, { ...base, owner_id: ownerId })
		return {
			step,
			wakeUp: {
				kind: 'none',
				reason: 'The owner is a person, so nobody is woken. They see the step on the object.',
			},
		}
	}

	if (ownerId !== ctx.actorId) {
		// Hand the step to another agent: they get a task, and this object waits on it.
		const [parent] = await tx
			.select({ title: objects.title })
			.from(objects)
			.where(eq(objects.id, object.id))
		const [task] = await tx
			.insert(objects)
			.values({
				workspaceId: object.workspaceId,
				type: 'task',
				title: childTaskTitle(input.action),
				content: `${input.action}\n\nThis is the next step on "${parent?.title ?? 'an object'}" (${object.id}), due ${dueAt.toISOString()}. When it is done, close the task with the result.`,
				status: 'backlog',
				driver: ownerId,
				createdBy: ctx.actorId,
			})
			.returning()
		if (!task) throw new Error('child task insert returned no row')
		await recordEvent(tx, {
			workspaceId: object.workspaceId,
			actorId: ctx.actorId,
			action: 'created',
			entityType: 'task',
			entityId: task.id,
			data: task,
			provenance: { sessionId: ctx.sessionId ?? undefined, entityKind: 'object' },
		})
		const [edge] = await tx
			.insert(relationships)
			.values({
				sourceType: 'object',
				sourceId: object.id,
				targetType: 'object',
				targetId: task.id,
				type: 'breaks_into',
				createdBy: ctx.actorId,
			})
			.returning()
		if (edge) {
			await recordEvent(tx, {
				workspaceId: object.workspaceId,
				actorId: ctx.actorId,
				action: 'created',
				entityType: 'relationship',
				entityId: edge.id,
				data: edge,
			})
		}
		// The move to todo is a real status change, which is what wakes the task's driver.
		await tx.update(objects).set({ status: 'todo', updatedAt: now }).where(eq(objects.id, task.id))
		await recordEvent(tx, {
			workspaceId: object.workspaceId,
			actorId: ctx.actorId,
			action: 'status_changed',
			entityType: 'task',
			entityId: task.id,
			data: { changes: [{ field: 'status', old: 'backlog', new: 'todo' }] },
			provenance: { sessionId: ctx.sessionId ?? undefined, entityKind: 'object' },
		})
		const step = await setNextStep(tx, ctx, {
			...base,
			owner_id: ownerId,
			blocked_on_object_id: task.id,
			blocked_reason: `Waiting for ${owner.name ?? 'the agent'} to finish the task`,
		})
		return { step, wakeUp: { kind: 'task', task_id: task.id } }
	}

	// The caller is the owner: wake them at the due time, on this object.
	const leadMs = MIN_WAKE_LEAD_MINUTES * 60_000
	if (dueAt.getTime() - now.getTime() < leadMs) {
		throw new NextStepError(
			'BAD_REQUEST',
			`due_at is less than ${MIN_WAKE_LEAD_MINUTES} minutes away. Pick a later time, or do the step now.`,
		)
	}
	const step = await setNextStep(tx, ctx, { ...base, owner_id: ownerId })
	const [trigger] = await tx
		.insert(triggers)
		.values({
			workspaceId: object.workspaceId,
			name: wakeName(input.action),
			type: 'reminder',
			config: { scheduled_at: dueAt.toISOString(), object_id: object.id, step_id: step.id },
			actionPrompt: wakePrompt(input.action),
			targetActorId: ownerId,
			enabled: true,
			createdBy: ctx.actorId,
		})
		.returning()
	if (!trigger) throw new Error('wake-up trigger insert returned no row')
	await recordEvent(tx, {
		workspaceId: object.workspaceId,
		actorId: ctx.actorId,
		action: 'created',
		entityType: 'trigger',
		entityId: trigger.id,
		data: {
			trigger_name: trigger.name,
			type: trigger.type,
			...(ctx.createdFromStartReason
				? { created_from_start_reason: ctx.createdFromStartReason }
				: {}),
		},
	})
	const [linked] = await tx
		.update(nextSteps)
		.set({ wakeTriggerId: trigger.id })
		.where(eq(nextSteps.id, step.id))
		.returning()
	return {
		step: linked ?? step,
		wakeUp: { kind: 'reminder', trigger_id: trigger.id, at: dueAt.toISOString() },
	}
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
	opts: {
		workspaceId?: string
		driverId?: string
		now?: Date
		/** Only for objects with no step: those not touched since this time. An overdue step is flagged regardless. */
		notUpdatedSince?: Date
		limit?: number
	} = {},
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
				opts.driverId ? eq(objects.driver, opts.driverId) : undefined,
				or(
					and(
						isNull(nextSteps.id),
						opts.notUpdatedSince ? lt(objects.updatedAt, opts.notUpdatedSince) : undefined,
					),
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
