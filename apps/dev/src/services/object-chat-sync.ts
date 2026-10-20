import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	conversationParticipants,
	conversations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'

// How much comment history a new object chat opens with. Older comments stay on
// the Activity tab; a chat that opens with thousands of rows helps nobody.
const IMPORT_LIMIT = 500

type CommentData = {
	content?: unknown
	mentions?: unknown
	parentEventId?: unknown
	metadata?: { via_chat?: unknown } | null
}

type CommentRow = {
	id: number
	actorId: string
	createdAt: Date | null
	data: unknown
}

function asMentions(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const ids = value.filter((v): v is string => typeof v === 'string')
	return ids.length > 0 ? ids : undefined
}

// Puts one comment into a chat as a message. A reply to a comment that is
// already a message becomes a thread reply under the top-level message.
// Returns the new message id, or null if the comment was already there or
// has nothing to show.
async function insertCommentAsMessage(
	db: Database | Transaction,
	conversationId: string,
	comment: CommentRow,
): Promise<number | null> {
	const data = (comment.data ?? {}) as CommentData
	if (typeof data.content !== 'string' || data.content.trim() === '') return null
	// Written from the chat itself: the message already exists.
	if (data.metadata?.via_chat) return null

	let threadRootId: number | null = null
	if (typeof data.parentEventId === 'number') {
		const [parent] = await db
			.select({ id: messages.id, threadRootId: messages.threadRootId })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					sql`(${messages.metadata}->>'comment_event_id') = ${String(data.parentEventId)}`,
				),
			)
			.limit(1)
		if (parent) threadRootId = parent.threadRootId ?? parent.id
	}

	const mentions = asMentions(data.mentions)
	const [created] = await db
		.insert(messages)
		.values({
			conversationId,
			actorId: comment.actorId,
			content: data.content,
			metadata: { comment_event_id: comment.id, ...(mentions ? { mentions } : {}) },
			...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
			...(threadRootId ? { threadRootId, threadAlsoInChannel: true } : {}),
		})
		.onConflictDoNothing()
		.returning({ id: messages.id })
	return created?.id ?? null
}

/**
 * Opens an object's new chat with its existing comments, oldest first, so the
 * conversation reads as the history of the task. People who commented join the
 * chat; agents do not, because every participant agent is asked to weigh in on
 * every new message. Everyone who is in the chat starts with it read.
 */
export async function importObjectComments(
	db: Database,
	args: { conversationId: string; workspaceId: string; objectId: string; actorId: string },
): Promise<void> {
	const latest = await db
		.select({
			id: events.id,
			actorId: events.actorId,
			createdAt: events.createdAt,
			data: events.data,
		})
		.from(events)
		.where(
			and(
				eq(events.workspaceId, args.workspaceId),
				eq(events.entityType, 'object'),
				eq(events.entityId, args.objectId),
				eq(events.action, 'commented'),
			),
		)
		.orderBy(desc(events.id))
		.limit(IMPORT_LIMIT)
	const comments = latest.reverse()
	if (comments.length === 0) return

	let lastId: number | null = null
	for (const comment of comments) {
		lastId = (await insertCommentAsMessage(db, args.conversationId, comment)) ?? lastId
	}
	if (lastId === null) return

	const authorIds = Array.from(new Set(comments.map((c) => c.actorId)))
	const humans = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(
			workspaceMembers,
			and(
				eq(workspaceMembers.actorId, actors.id),
				eq(workspaceMembers.workspaceId, args.workspaceId),
			),
		)
		.where(and(inArray(actors.id, authorIds), eq(actors.type, 'human')))
	await db
		.insert(conversationParticipants)
		.values(
			humans.map((h) => ({
				conversationId: args.conversationId,
				actorId: h.id,
				addedBy: args.actorId,
			})),
		)
		.onConflictDoNothing()

	await db
		.update(conversationParticipants)
		.set({ lastReadMessageId: lastId })
		.where(eq(conversationParticipants.conversationId, args.conversationId))
	await db
		.update(conversations)
		.set({ lastMessageAt: new Date(), updatedAt: new Date() })
		.where(eq(conversations.id, args.conversationId))
}

/**
 * A comment posted the old way (the web box, `create_comment`) also appears in
 * the object's chat, if it has one. Best effort and plain inserts only: the
 * caller may be inside a transaction that a failed statement would poison.
 */
export async function mirrorCommentIntoChat(
	db: Database | Transaction,
	comment: CommentRow & { workspaceId: string; entityId: string },
): Promise<void> {
	try {
		const [conversation] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.workspaceId, comment.workspaceId),
					eq(conversations.subjectType, 'object'),
					eq(conversations.subjectId, comment.entityId),
				),
			)
			.limit(1)
		if (!conversation) return

		const messageId = await insertCommentAsMessage(db, conversation.id, comment)
		if (messageId === null) return

		await db
			.update(conversations)
			.set({ lastMessageAt: comment.createdAt ?? new Date(), updatedAt: new Date() })
			.where(eq(conversations.id, conversation.id))
		await recordEvent(db, {
			workspaceId: comment.workspaceId,
			actorId: comment.actorId,
			action: 'message_posted',
			entityType: 'conversation',
			entityId: conversation.id,
			data: { message_id: messageId, author_actor_id: comment.actorId, via: 'comment' },
		})
	} catch (err) {
		logger.error('Failed to mirror comment into object chat', {
			eventId: comment.id,
			error: String(err),
		})
	}
}
