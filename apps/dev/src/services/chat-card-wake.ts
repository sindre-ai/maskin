import type { Database } from '@maskin/db'
import { actors, conversationParticipants, conversations, messages } from '@maskin/db/schema'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { deliverTurnToAgent } from './conversation-responder'
import type { SessionManager } from './session-manager'

/**
 * The chat a card sits in and the agent whose message holds it. Sent with an approval or a
 * status change made from that card, so the server can tell the agent directly.
 */
export interface ChatCard {
	conversation_id: string
	agent_id: string
}

const HISTORY_CONTEXT_MESSAGES = 15

const quote = (text: string) =>
	text
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')

/** What the agent is told when the person approves a draft on its card. */
export function approvedInstruction(object: { id: string; title: string | null }, text: string) {
	return `Approved "${object.title || 'Untitled'}" from the card in this chat. Send it exactly as it reads. If the send tool takes an object_id, send it passing object_id ${object.id}: the approved text is read from the object, and an edit made after this needs approving again. It reads:\n\n${quote(text)}`
}

/** What the agent is told when the person moves its card to another status. */
export function movedInstruction(
	object: { title: string | null; content: string | null },
	status: string,
) {
	return `Moved "${object.title || 'Untitled'}" to ${status} from the card in this chat. The text as it stands:\n\n${quote(object.content?.trim() ?? '')}`
}

/**
 * Tells the agent behind a chat card what the person just did on it (approved the draft,
 * moved its status), as a turn in that agent's chat session. No message is posted: the
 * person did not write anything, so nothing appears in the chat in their name. The agent's
 * own reply still lands in the chat as usual.
 *
 * Only wakes an agent that is in the chat, on behalf of a person who is in it too. Best
 * effort and never throws: the approval or status change has already been saved, so a
 * failure here is logged, not returned to the person.
 */
export async function wakeAgentFromCard(params: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	callerId: string
	card: ChatCard
	instruction: string
}): Promise<boolean> {
	const { db, sessionManager, workspaceId, callerId, card, instruction } = params
	const conversationId = card.conversation_id
	const agentId = card.agent_id
	try {
		const [conversation] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
			.limit(1)
		if (!conversation) return false

		const participants = await db
			.select({ actorId: actors.id, name: actors.name, type: actors.type })
			.from(conversationParticipants)
			.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
			.where(
				and(
					eq(conversationParticipants.conversationId, conversationId),
					isNull(conversationParticipants.leftAt),
				),
			)
		const caller = participants.find((p) => p.actorId === callerId)
		const agent = participants.find((p) => p.actorId === agentId && p.type === 'agent')
		if (!caller || !agent) {
			logger.warn('Chat card wake skipped: caller or agent is not in the chat', {
				conversationId,
				agentId,
			})
			return false
		}

		// The agent's latest message in the main timeline holds the card. Its reply is
		// anchored after that message, the place the person acted.
		const [anchor] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.actorId, agentId),
					isNull(messages.threadRootId),
				),
			)
			.orderBy(desc(messages.id))
			.limit(1)
		if (!anchor) {
			logger.warn('Chat card wake skipped: the agent has no message in the chat', {
				conversationId,
				agentId,
			})
			return false
		}

		const historyRows = await db
			.select({ actorName: actors.name, content: messages.content })
			.from(messages)
			.innerJoin(actors, eq(actors.id, messages.actorId))
			.where(eq(messages.conversationId, conversationId))
			.orderBy(desc(messages.id))
			.limit(HISTORY_CONTEXT_MESSAGES)

		await deliverTurnToAgent({
			db,
			sessionManager,
			workspaceId,
			conversationId,
			messageId: anchor.id,
			agentId,
			message: {
				actorId: callerId,
				authorName: caller.name,
				authorType: caller.type,
				content: instruction,
			},
			conversationHistory: historyRows.slice().reverse(),
			isDirectConversation: participants.length === 2,
			wasMentioned: true,
		})
		return true
	} catch (err) {
		logger.error('Chat card wake failed', { conversationId, agentId, error: String(err) })
		return false
	}
}
