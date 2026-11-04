import type { Database, Transaction } from '@maskin/db'
import { conversationParticipants, conversations } from '@maskin/db/schema'
import type { MessageDelivery, MessageMetadata } from '@maskin/shared'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import {
	type InsertedConversationMessage,
	insertConversationMessage,
} from './conversation-messages'

/**
 * The direct message (DM) primitive shared by the agent-intro bet and the
 * capability-scan bet. A DM is stored: conversations.direct_pair_key marks the
 * one chat per pair of actors in a workspace. A topical chat with the same two
 * people has no key, so it is never mistaken for the DM, however recently used.
 *
 * findDirectChat and postToDirectChat are first built by the capability-scan
 * bet (bet/3dae-capability-scan). They are copied here with the same names and
 * signatures so the swap is a rebase of one file. Do not define a second
 * lookup or a second post function.
 */

export interface FindDirectChatArgs {
	workspaceId: string
	/** The two ids are interchangeable: the key does not depend on their order. */
	humanId: string
	agentId: string
}

/**
 * The key stored on a DM: both actor ids, lowest first. Lowercased so a
 * differently cased id still lands on the same key (the migration backfill
 * builds the same string from uuid columns).
 */
export function directPairKey(a: string, b: string): string {
	return [a.toLowerCase(), b.toLowerCase()].sort().join(':')
}

/**
 * The DM between two actors, while both are in it and nobody else is. Find only,
 * never creates, and never returns a topical chat.
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
			AND c.direct_pair_key = ${directPairKey(args.humanId, args.agentId)}
			AND (
				SELECT count(*) FROM conversation_participants p
				WHERE p.conversation_id = c.id AND p.left_at IS NULL
			) = 2
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
 * The DM between two actors, created when it does not exist yet.
 *
 * The unique index on the pair key is the hard guarantee of one DM per pair. A
 * transaction-scoped advisory lock keyed on the same key makes two concurrent
 * callers queue instead of one of them failing on the index: the second waits,
 * then finds the first caller's chat.
 *
 * An existing DM is returned as it is, whatever its title, and anyone who left
 * it comes back: there is only one DM per pair, so it cannot be replaced by a
 * new chat. Topical chats with the same people are ignored.
 *
 * Given a Transaction this joins it (a savepoint), so the lock is held until
 * the caller's own transaction ends. A caller that posts into the chat in the
 * same transaction can then check and insert under the lock.
 */
export async function findOrCreateDirectChat(
	db: Database | Transaction,
	args: FindOrCreateDirectChatArgs,
): Promise<{ id: string; created: boolean }> {
	const pairKey = directPairKey(args.humanId, args.agentId)
	// A Transaction has the same transaction() (a savepoint), but calling it on the
	// Database | Transaction union does not type-check, so narrow it here.
	return (db as Database).transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${args.workspaceId}::text || ${pairKey}))`,
		)

		const [existing] = await tx
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.workspaceId, args.workspaceId),
					eq(conversations.directPairKey, pairKey),
				),
			)
			.limit(1)
		if (existing) {
			await tx
				.update(conversationParticipants)
				.set({ leftAt: null, updatedAt: new Date() })
				.where(
					and(
						eq(conversationParticipants.conversationId, existing.id),
						inArray(conversationParticipants.actorId, [args.humanId, args.agentId]),
						isNotNull(conversationParticipants.leftAt),
					),
				)
			return { id: existing.id, created: false }
		}

		const [conversation] = await tx
			.insert(conversations)
			.values({
				workspaceId: args.workspaceId,
				title: args.title,
				titleAutoState: 'none',
				createdBy: args.createdBy,
				directPairKey: pairKey,
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
