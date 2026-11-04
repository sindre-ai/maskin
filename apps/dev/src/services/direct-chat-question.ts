import type { Database } from '@maskin/db'
import { conversations, messages } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { findDirectChat } from './direct-chat'

/**
 * The direct message a question sits in, when it is a question this session asked there and the
 * caller is the person in that chat. Null for anything else, which leaves the caller on its
 * existing path. The message has to be the asking agent's own question for this session, in a
 * conversation that still carries the direct pair key, and findDirectChat has to return that same
 * conversation for the caller and the agent (so it is a two-person chat of exactly those two).
 */
export async function findDirectChatQuestion(
	db: Database,
	args: {
		workspaceId: string
		sessionId: string
		agentId: string
		callerId: string
		questionMessageId: number
	},
): Promise<{ conversationId: string; answered: boolean } | null> {
	const [question] = await db
		.select({ conversationId: messages.conversationId })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(messages.id, args.questionMessageId),
				eq(messages.actorId, args.agentId),
				eq(conversations.workspaceId, args.workspaceId),
				sql`${conversations.directPairKey} IS NOT NULL`,
				sql`${messages.metadata}->'question'->>'session_id' = ${args.sessionId}`,
			),
		)
		.limit(1)
	if (!question) return null

	const direct = await findDirectChat(db, {
		workspaceId: args.workspaceId,
		humanId: args.callerId,
		agentId: args.agentId,
	})
	if (direct?.id !== question.conversationId) return null

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
