import type { Database, Transaction } from '@maskin/db'
import {
	actors,
	conversations,
	jobGoAheads,
	messages,
	objects,
	workspaceMembers,
} from '@maskin/db/schema'
import { TERMINAL_STATUSES_BY_TYPE } from '@maskin/shared'
import type { GoAheadResponse, RecordGoAheadInput } from '@maskin/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { recordEvent } from './events/record-event'

type GoAheadRow = typeof jobGoAheads.$inferSelect

/** A write the caller got wrong or may not make. The route maps the code to a status. */
export class GoAheadError extends Error {
	constructor(
		readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN',
		message: string,
	) {
		super(message)
		this.name = 'GoAheadError'
	}
}

interface WriteContext {
	objectId: string
	actorId: string
}

function isClosed(type: string, status: string): boolean {
	return (TERMINAL_STATUSES_BY_TYPE[type] ?? []).includes(status)
}

export function serializeGoAhead(row: GoAheadRow, grantedByName: string): GoAheadResponse {
	return {
		id: row.id,
		object_id: row.objectId,
		granted_by: row.grantedBy,
		granted_by_name: grantedByName,
		via: row.via as GoAheadResponse['via'],
		message_id: row.messageId,
		granted_at: row.grantedAt.toISOString(),
	}
}

/**
 * The job's live go-ahead, or null. A go-ahead ends when the job closes, and that is read here from
 * the object's status: nothing is stored or cleaned up when a job closes.
 */
export async function getLiveGoAhead(
	db: Database | Transaction,
	objectId: string,
): Promise<GoAheadResponse | null> {
	const [found] = await db
		.select({ row: jobGoAheads, name: actors.name, type: objects.type, status: objects.status })
		.from(jobGoAheads)
		.innerJoin(objects, eq(objects.id, jobGoAheads.objectId))
		.innerJoin(actors, eq(actors.id, jobGoAheads.grantedBy))
		.where(and(eq(jobGoAheads.objectId, objectId), isNull(jobGoAheads.takenBackAt)))
		.limit(1)
	if (!found || isClosed(found.type, found.status)) return null
	return serializeGoAhead(found.row, found.name)
}

async function lockObject(tx: Transaction, objectId: string) {
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
	if (!object) throw new GoAheadError('NOT_FOUND', 'Object not found')
	return object
}

async function actorTypeOf(tx: Transaction, actorId: string): Promise<string | null> {
	const [actor] = await tx
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	return actor?.type ?? null
}

/**
 * The person behind a quoted chat message. Three checks, in this order: the message exists and
 * sits in a chat about this job; a person wrote it (not an agent, not a system line, not anything
 * a session posted); that person may write in this workspace.
 */
async function personBehindMessage(
	tx: Transaction,
	object: { id: string; workspaceId: string },
	messageId: number,
): Promise<string> {
	const [message] = await tx
		.select({
			actorId: messages.actorId,
			kind: messages.kind,
			sessionId: messages.sessionId,
			deletedAt: messages.deletedAt,
			subjectType: conversations.subjectType,
			subjectId: conversations.subjectId,
			workspaceId: conversations.workspaceId,
		})
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(eq(messages.id, messageId))
		.limit(1)
	if (
		!message ||
		message.deletedAt ||
		message.workspaceId !== object.workspaceId ||
		message.subjectType !== 'object' ||
		message.subjectId !== object.id
	) {
		throw new GoAheadError(
			'BAD_REQUEST',
			'message_id is not a message in a chat about this job. Quote the person’s message from a chat about this job.',
		)
	}
	const authorType = await actorTypeOf(tx, message.actorId)
	if (authorType !== 'human' || message.kind !== 'message' || message.sessionId !== null) {
		throw new GoAheadError(
			'FORBIDDEN',
			'A go-ahead has to come from a person’s own message. That message was not written by a person.',
		)
	}
	const [member] = await tx
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, object.workspaceId),
				eq(workspaceMembers.actorId, message.actorId),
			),
		)
		.limit(1)
	if (!member || member.role === 'viewer') {
		throw new GoAheadError('FORBIDDEN', 'That person cannot give a go-ahead in this workspace.')
	}
	return message.actorId
}

/**
 * Record a person's go-ahead on a job. Who gave it is always a person: the caller when they
 * approved a card, or the author of the quoted chat message. An agent can record what a person
 * said, never grant one on its own. The job already having a live go-ahead is not an error: the
 * existing one comes back unchanged (created false). One transaction with the audit event.
 */
export async function recordGoAhead(
	tx: Transaction,
	ctx: WriteContext,
	input: RecordGoAheadInput,
): Promise<{ goAhead: GoAheadResponse; created: boolean }> {
	const object = await lockObject(tx, ctx.objectId)
	if (isClosed(object.type, object.status)) {
		throw new GoAheadError(
			'BAD_REQUEST',
			'This job is closed. A go-ahead ends when the job closes.',
		)
	}

	let grantedBy: string
	if (input.via === 'card') {
		if ((await actorTypeOf(tx, ctx.actorId)) !== 'human') {
			throw new GoAheadError('FORBIDDEN', 'Only a person can give a go-ahead by approving a card.')
		}
		grantedBy = ctx.actorId
	} else {
		if (input.message_id === undefined) {
			throw new GoAheadError('BAD_REQUEST', 'via chat needs message_id')
		}
		grantedBy = await personBehindMessage(tx, object, input.message_id)
	}

	const [live] = await tx
		.select({ row: jobGoAheads, name: actors.name })
		.from(jobGoAheads)
		.innerJoin(actors, eq(actors.id, jobGoAheads.grantedBy))
		.where(and(eq(jobGoAheads.objectId, object.id), isNull(jobGoAheads.takenBackAt)))
		.limit(1)
	if (live) return { goAhead: serializeGoAhead(live.row, live.name), created: false }

	const [row] = await tx
		.insert(jobGoAheads)
		.values({
			workspaceId: object.workspaceId,
			objectId: object.id,
			grantedBy,
			via: input.via,
			messageId: input.via === 'chat' ? (input.message_id ?? null) : null,
			recordedBy: ctx.actorId,
		})
		.returning()
	if (!row) throw new Error('go-ahead insert returned no row')
	const [granter] = await tx
		.select({ name: actors.name })
		.from(actors)
		.where(eq(actors.id, grantedBy))
		.limit(1)

	await recordEvent(tx, {
		workspaceId: object.workspaceId,
		actorId: ctx.actorId,
		action: 'go_ahead_recorded',
		entityType: object.type,
		entityId: object.id,
		data: {
			go_ahead_id: row.id,
			granted_by: grantedBy,
			via: row.via,
			message_id: row.messageId,
			recorded_by: ctx.actorId,
		},
	})
	return { goAhead: serializeGoAhead(row, granter?.name ?? 'Someone'), created: true }
}

/**
 * Take the go-ahead back. A person or an agent may do it: it only makes things safer. The row
 * stays as the record. NOT_FOUND when the job has no live go-ahead.
 */
export async function takeBackGoAhead(
	tx: Transaction,
	ctx: WriteContext,
): Promise<GoAheadResponse> {
	const object = await lockObject(tx, ctx.objectId)
	const [live] = await tx
		.select({ row: jobGoAheads, name: actors.name })
		.from(jobGoAheads)
		.innerJoin(actors, eq(actors.id, jobGoAheads.grantedBy))
		.where(and(eq(jobGoAheads.objectId, object.id), isNull(jobGoAheads.takenBackAt)))
		.limit(1)
	if (!live) throw new GoAheadError('NOT_FOUND', 'This job has no go-ahead to take back.')

	await tx
		.update(jobGoAheads)
		.set({ takenBackAt: new Date(), takenBackBy: ctx.actorId })
		.where(eq(jobGoAheads.id, live.row.id))
	await recordEvent(tx, {
		workspaceId: object.workspaceId,
		actorId: ctx.actorId,
		action: 'go_ahead_taken_back',
		entityType: object.type,
		entityId: object.id,
		data: { go_ahead_id: live.row.id, granted_by: live.row.grantedBy, taken_back_by: ctx.actorId },
	})
	return serializeGoAhead(live.row, live.name)
}
