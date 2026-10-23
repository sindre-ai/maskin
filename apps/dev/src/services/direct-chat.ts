import type { Database, Transaction } from '@maskin/db'
import { conversationParticipants, conversations } from '@maskin/db/schema'
import type { MessageDelivery, MessageMetadata } from '@maskin/shared'
import { sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import {
	type InsertedConversationMessage,
	insertConversationMessage,
} from './conversation-messages'

/**
 * The 1-1 chat primitive shared by the agent-intro bet and the capability-scan
 * bet. A 1-1 is derived, never stored: exactly two active participants, one
 * human and one agent (the responder's isDirect rule). No direct column.
 *
 * findDirectChat and postToDirectChat are first built by the capability-scan
 * bet (bet/3dae-capability-scan). They are copied here with the same names and
 * signatures so the swap is a rebase of one file. Do not define a second
 * lookup or a second post function.
 */

export interface FindDirectChatArgs {
	workspaceId: string
	humanId: string
	agentId: string
}

/**
 * The active 1-1 between one human and one agent: both are active participants
 * and nobody else is. Find only, never creates. When the person has more than
 * one such chat the most recently used wins.
 */
export async function findDirectChat(
	db: Database | Transaction,
	args: FindDirectChatArgs,
): Promise<{ id: string } | null> {
	const rows = (await db.execute(sql`
		SELECT c.id
		FROM conversations c
		JOIN conversation_participants h
			ON h.conversation_id = c.id AND h.actor_id = ${args.humanId} AND h.left_at IS NULL
		JOIN conversation_participants a
			ON a.conversation_id = c.id AND a.actor_id = ${args.agentId} AND a.left_at IS NULL
		WHERE c.workspace_id = ${args.workspaceId}
			AND (
				SELECT count(*) FROM conversation_participants p
				WHERE p.conversation_id = c.id AND p.left_at IS NULL
			) = 2
		ORDER BY c.last_message_at DESC, c.id
		LIMIT 1
	`)) as unknown as Array<{ id: string }>
	return rows[0] ? { id: rows[0].id } : null
}

export interface PostToDirectChatArgs {
	conversationId: string
	workspaceId: string
	agentId: string
	content: string
	delivery: MessageDelivery
	/** Backend-owned keys written in the same insert as the delivery marker. */
	extraMetadata?: Pick<MessageMetadata, 'suggested_steps' | 'needed_tools' | 'plain_tail'>
}

/**
 * Puts an agent-authored message into a chat. Goes through
 * insertConversationMessage and never calls evaluateAndRespond, so nothing is
 * woken and no session starts. The caller is responsible for every policy
 * check (who may speak, caps, flags).
 */
export async function postToDirectChat(
	db: Database | Transaction,
	args: PostToDirectChatArgs,
): Promise<InsertedConversationMessage> {
	const created = await insertConversationMessage(db, {
		conversationId: args.conversationId,
		workspaceId: args.workspaceId,
		actorId: args.agentId,
		content: args.content,
		metadata: { ...args.extraMetadata, delivery: args.delivery },
		sessionId: null,
	})
	if (!created) throw new Error('postToDirectChat: insert was suppressed')
	return created
}

export interface FindOrCreateDirectChatArgs extends FindDirectChatArgs {
	/** Explicit title. The chat is created with title_auto_state 'none'. */
	title: string
	/** Becomes conversations.created_by and the actor of the conversation_created event. */
	createdBy: string
}

/**
 * The 1-1 between a human and an agent, created when it does not exist yet.
 *
 * Nothing in the schema is unique on the pair, so two concurrent callers would
 * otherwise each create one. A transaction-scoped advisory lock keyed on the
 * workspace, human and agent serializes them: the second caller waits, then
 * finds the first caller's chat. The find half is findDirectChat, so there is
 * one definition of "a 1-1" and no second participant query here.
 *
 * Given a Transaction this joins it (a savepoint), so the lock is held until
 * the caller's own transaction ends. A caller that posts into the chat in the
 * same transaction can then check and insert under the lock.
 */
export async function findOrCreateDirectChat(
	db: Database | Transaction,
	args: FindOrCreateDirectChatArgs,
): Promise<{ id: string; created: boolean }> {
	// A Transaction has the same transaction() (a savepoint), but calling it on the
	// Database | Transaction union does not type-check, so narrow it here.
	return (db as Database).transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${args.workspaceId}::text || ${args.humanId}::text || ${args.agentId}::text))`,
		)

		const existing = await findDirectChat(tx, args)
		if (existing) return { id: existing.id, created: false }

		const [conversation] = await tx
			.insert(conversations)
			.values({
				workspaceId: args.workspaceId,
				title: args.title,
				titleAutoState: 'none',
				createdBy: args.createdBy,
			})
			.returning({ id: conversations.id })
		if (!conversation) throw new Error('Failed to create conversation')

		await tx.insert(conversationParticipants).values(
			[args.humanId, args.agentId].map((actorId) => ({
				conversationId: conversation.id,
				actorId,
				addedBy: args.humanId,
				pinned: false,
				archived: false,
				lastReadMessageId: null,
			})),
		)

		await recordEvent(tx, {
			workspaceId: args.workspaceId,
			actorId: args.createdBy,
			action: 'conversation_created',
			entityType: 'conversation',
			entityId: conversation.id,
			data: { participant_actor_ids: [args.humanId, args.agentId] },
		})

		return { id: conversation.id, created: true }
	})
}
