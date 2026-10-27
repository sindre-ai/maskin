import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	masterChats,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'

/**
 * The master chat: the one stored 1-1 between a person and an agent, where that agent puts a
 * question when its session has no chat of its own. Unlike the chat the responder treats as 1-1
 * (two active participants), this one is a stored row in master_chats, so a topical chat that
 * happens to hold the same two people is never returned for it.
 */

class LostMasterChatRace extends Error {}

/**
 * The master chat for this person and agent, created on first use. Two concurrent first calls
 * for the same pair produce one chat: each builds its chat and tries to insert the row, the
 * primary key lets one win, and the other rolls its chat back and reads the winner's row.
 *
 * Null when the person is not a human member of the workspace or the agent is not an agent
 * member of it, so a chat is never made for someone outside the workspace.
 */
export async function findOrCreateMasterChat(
	db: Database,
	workspaceId: string,
	humanId: string,
	agentId: string,
): Promise<{ id: string; created: boolean } | null> {
	const members = await db
		.select({ id: actors.id, type: actors.type, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				inArray(workspaceMembers.actorId, [humanId, agentId]),
			),
		)
	const human = members.find((m) => m.id === humanId && m.type === 'human')
	const agent = members.find((m) => m.id === agentId && m.type === 'agent')
	if (!human || !agent) return null

	const existing = await readMasterChat(db, workspaceId, humanId, agentId)
	if (existing) return { id: existing, created: false }

	try {
		const id = await db.transaction(async (tx) => {
			const [conversation] = await tx
				.insert(conversations)
				.values({
					workspaceId,
					title: agent.name,
					titleAutoState: 'none',
					createdBy: humanId,
				})
				.returning({ id: conversations.id })
			if (!conversation) throw new Error('Failed to create master chat conversation')

			const [claimed] = await tx
				.insert(masterChats)
				.values({ workspaceId, humanId, agentId, conversationId: conversation.id })
				.onConflictDoNothing()
				.returning({ conversationId: masterChats.conversationId })
			// Another caller's row won the key: undo this chat so nothing is left behind.
			if (!claimed) throw new LostMasterChatRace()

			const participantIds = [humanId, agentId]
			await tx.insert(conversationParticipants).values(
				participantIds.map((actorId) => ({
					conversationId: conversation.id,
					actorId,
					addedBy: humanId,
					pinned: false,
					archived: false,
					lastReadMessageId: null,
				})),
			)
			await recordEvent(tx, {
				workspaceId,
				actorId: humanId,
				action: 'conversation_created',
				entityType: 'conversation',
				entityId: conversation.id,
				data: { participant_actor_ids: participantIds, source: 'master_chat' },
			})
			return conversation.id
		})
		return { id, created: true }
	} catch (err) {
		if (!(err instanceof LostMasterChatRace)) throw err
		const winner = await readMasterChat(db, workspaceId, humanId, agentId)
		if (!winner) throw new Error('Master chat row vanished after losing the insert race')
		return { id: winner, created: false }
	}
}

async function readMasterChat(
	db: Database,
	workspaceId: string,
	humanId: string,
	agentId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ conversationId: masterChats.conversationId })
		.from(masterChats)
		.where(
			and(
				eq(masterChats.workspaceId, workspaceId),
				eq(masterChats.humanId, humanId),
				eq(masterChats.agentId, agentId),
			),
		)
		.limit(1)
	return row?.conversationId ?? null
}

/** The person and agent a conversation is the master chat of, or null if it is not one. */
export async function findMasterChatPair(
	db: Database,
	conversationId: string,
): Promise<{ humanId: string; agentId: string } | null> {
	const [row] = await db
		.select({ humanId: masterChats.humanId, agentId: masterChats.agentId })
		.from(masterChats)
		.where(eq(masterChats.conversationId, conversationId))
		.limit(1)
	return row ?? null
}

/**
 * True when adding these actors would put a third participant into a master chat. Re-adding
 * the two people it belongs to is fine. Every place that adds participants to an existing chat
 * asks this first and refuses with a 409.
 */
export async function wouldWidenMasterChat(
	db: Database,
	conversationId: string,
	actorIds: string[],
): Promise<boolean> {
	const pair = await findMasterChatPair(db, conversationId)
	if (!pair) return false
	return actorIds.some((actorId) => actorId !== pair.humanId && actorId !== pair.agentId)
}

export const MASTER_CHAT_FULL_MESSAGE =
	'This is a master chat between one person and one agent. Nobody else can be added to it.'

/**
 * The master chat a question message sits in, when it is a question this session asked there.
 * Null for anything else, which leaves the caller on its existing path. The message has to be
 * the asking agent's own question for this session, in a conversation stored in master_chats.
 */
export async function findMasterQuestion(
	db: Database,
	args: { workspaceId: string; sessionId: string; agentId: string; questionMessageId: number },
): Promise<{ conversationId: string; answered: boolean } | null> {
	const [question] = await db
		.select({ conversationId: messages.conversationId })
		.from(messages)
		.innerJoin(masterChats, eq(masterChats.conversationId, messages.conversationId))
		.where(
			and(
				eq(messages.id, args.questionMessageId),
				eq(messages.actorId, args.agentId),
				eq(masterChats.workspaceId, args.workspaceId),
				sql`${messages.metadata}->'question'->>'session_id' = ${args.sessionId}`,
			),
		)
		.limit(1)
	if (!question) return null

	const [answer] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, question.conversationId),
				sql`${messages.metadata}->'question_answer'->>'question_message_id' = ${String(args.questionMessageId)}`,
			),
		)
		.limit(1)
	return { conversationId: question.conversationId, answered: !!answer }
}
