import type { Database, Transaction } from '@maskin/db'
import { conversations, messages } from '@maskin/db/schema'
import type { MessageMetadata } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { postComment } from '../lib/comments'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { notifyChatMention, notifyChatReply, resolveAnsweredQuestions } from './chat-notifications'

export type InsertConversationMessageArgs = {
	conversationId: string
	workspaceId: string
	/** The author — human or agent; role is derived from actors.type. */
	actorId: string
	content: string
	metadata: MessageMetadata | null
	sessionId: string | null
	kind?: 'message' | 'system'
	/** Reply in the thread rooted at this message id; null/absent for a top-level message. */
	threadRootId?: number | null
	/** With threadRootId: also show the reply in the main timeline. */
	threadAlsoInChannel?: boolean
	/** Do not copy a message of an object's chat onto the object as a comment (a call receipt is not something said). */
	skipObjectMirror?: boolean
}

export type InsertedConversationMessage = typeof messages.$inferSelect

/**
 * The mechanics of putting a message into a conversation: insert the row, bump
 * the conversation's denormalized `lastMessageAt`, and log the `message_posted`
 * event that drives the audit trail and SSE invalidation.
 *
 * Shared by the POST /conversations/:id/messages route (human + MCP-authored
 * messages) and the interactive turn finalizer (an agent's auto-posted
 * end-of-turn output), so the three writes can't drift apart between them.
 *
 * Deliberately does NOT run route policy — @mention auto-join, auto-titling,
 * and `evaluateAndRespond` stay with the route. That omission is what makes an
 * auto-posted final output structurally incapable of waking another agent.
 *
 * Takes a Database or a Transaction, so a caller holding a lock (the proactive
 * message service) can insert inside its own transaction.
 *
 * Returns null when the insert was suppressed by a unique constraint — the
 * finalizer's dedupe key. Callers that can't conflict should treat null as an
 * error.
 */
export async function insertConversationMessage(
	db: Database | Transaction,
	args: InsertConversationMessageArgs,
): Promise<InsertedConversationMessage | null> {
	const [created] = await db
		.insert(messages)
		.values({
			conversationId: args.conversationId,
			actorId: args.actorId,
			content: args.content,
			metadata: args.metadata,
			sessionId: args.sessionId,
			...(args.kind ? { kind: args.kind } : {}),
			...(args.threadRootId ? { threadRootId: args.threadRootId } : {}),
			...(args.threadRootId && args.threadAlsoInChannel ? { threadAlsoInChannel: true } : {}),
		})
		.onConflictDoNothing()
		.returning()

	if (!created) return null

	await db
		.update(conversations)
		.set({ lastMessageAt: created.createdAt ?? new Date(), updatedAt: new Date() })
		.where(eq(conversations.id, args.conversationId))

	await recordEvent(db, {
		workspaceId: args.workspaceId,
		actorId: args.actorId,
		action: 'message_posted',
		entityType: 'conversation',
		entityId: args.conversationId,
		data: {
			message_id: created.id,
			author_actor_id: args.actorId,
			...(args.threadRootId ? { thread_root_id: args.threadRootId } : {}),
		},
	})

	if ((args.kind ?? 'message') === 'message' && !args.skipObjectMirror) {
		await mirrorAsObjectComment(db, {
			conversationId: args.conversationId,
			workspaceId: args.workspaceId,
			actorId: args.actorId,
			content: args.content,
			mentions: args.metadata?.mentions,
			messageId: created.id,
		})
	}

	// The single hook for "an agent replied": every auto-posted final output
	// (both InteractiveTurnFinalizer paths) lands here, and only a fresh insert
	// reaches this line, so a replayed log line cannot notify twice.
	await notifyChatReply(db, {
		workspaceId: args.workspaceId,
		authorId: args.actorId,
		conversationId: args.conversationId,
		messageId: created.id,
		content: args.content,
		kind: args.kind,
		metadata: args.metadata,
		sessionId: args.sessionId,
	})

	// A person @mentioned in the message gets a push. Same fresh-insert guarantee
	// as above; auto-posted final outputs are left to notifyChatReply.
	await notifyChatMention(db, {
		workspaceId: args.workspaceId,
		authorId: args.actorId,
		conversationId: args.conversationId,
		messageId: created.id,
		content: args.content,
		kind: args.kind,
		metadata: args.metadata,
		sessionId: args.sessionId,
	})

	// The person replying in the chat answers any agent question waiting on them there.
	await resolveAnsweredQuestions(db, {
		workspaceId: args.workspaceId,
		conversationId: args.conversationId,
		answererId: args.actorId,
		messageId: created.id,
	})

	return created
}

/**
 * A chat about an object is where people now comment on it, but triggers, For You,
 * subscriptions and the Activity tab still read `commented` events. So a message in
 * an object's chat also lands as one, flagged `suppress_auto_dispatch`: the chat's
 * own responder already wakes the agents, and the comment dispatcher must not wake
 * them a second time. Event triggers still see it. Best effort: a failed mirror is
 * logged and never blocks the message.
 */
export async function mirrorAsObjectComment(
	db: Database | Transaction,
	msg: {
		conversationId: string
		workspaceId: string
		actorId: string
		content: string
		mentions?: string[]
		messageId: number
	},
): Promise<void> {
	try {
		const [conversation] = await db
			.select({ subjectType: conversations.subjectType, subjectId: conversations.subjectId })
			.from(conversations)
			.where(eq(conversations.id, msg.conversationId))
			.limit(1)
		if (conversation?.subjectType !== 'object' || !conversation.subjectId) return

		await postComment(db, {
			workspaceId: msg.workspaceId,
			actorId: msg.actorId,
			entityId: conversation.subjectId,
			content: msg.content,
			mentions: msg.mentions,
			metadata: {
				suppress_auto_dispatch: true,
				via_chat: { conversation_id: msg.conversationId, message_id: msg.messageId },
			},
		})
	} catch (err) {
		logger.error('Failed to mirror chat message as object comment', {
			conversationId: msg.conversationId,
			messageId: msg.messageId,
			error: String(err),
		})
	}
}
