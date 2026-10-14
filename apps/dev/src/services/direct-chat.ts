import type { Database, Transaction } from '@maskin/db'
import type { MessageDelivery } from '@maskin/shared'
import { sql } from 'drizzle-orm'
import {
	type InsertedConversationMessage,
	insertConversationMessage,
} from './conversation-messages'

/**
 * TEMPORARY local port of the two functions the sibling bet (A new agent starts
 * silent) will ship in this same file. Names and signatures are the ones the
 * Architect ruled on, so the swap is a one-line import change and whichever PR
 * lands second rebases. Nothing here is specific to proactive messages.
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
		metadata: { delivery: args.delivery },
		sessionId: null,
	})
	if (!created) throw new Error('postToDirectChat: insert was suppressed')
	return created
}
