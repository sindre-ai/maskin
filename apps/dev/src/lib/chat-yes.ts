import type { Database } from '@maskin/db'
import { actors, conversationParticipants, conversations, messages } from '@maskin/db/schema'
import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { getWorkspaceRole } from './workspace-auth'

/**
 * A person's yes in a chat, for a gate that has no draft to hash (deleting an agent).
 *
 * Same trust model as chat-approval.ts: the server never takes the agent's word that a person
 * said yes. It reads the message the agent names and accepts it only when every one of these holds:
 *
 *  - the calling agent is in the chat the message sits in;
 *  - a person who can write in the workspace wrote it (never an agent);
 *  - it is that person's newest message in the chat, so an older "thanks" cannot be cited;
 *  - it is not older than `maxAgeMs`;
 *  - an earlier message in the chat names the target (its id outside code), and that message was
 *    not edited after the person replied.
 *
 * What the server cannot tell is whether the words mean yes. It proves who wrote them, where,
 * and that they were written after the chat showed the target.
 */

const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g
const INLINE_CODE = /(`+)[^`\n][\s\S]*?\1(?!`)/g

/** True when the message names the id outside code (a link or the bare id). */
export function namesTarget(content: string, targetId: string): boolean {
	const text = content.replace(FENCED_CODE, '$1').replace(INLINE_CODE, '')
	const id = targetId.toLowerCase()
	let from = 0
	const lower = text.toLowerCase()
	for (;;) {
		const at = lower.indexOf(id, from)
		if (at === -1) return false
		// Not the middle of a longer id-like token.
		const before = lower[at - 1]
		const after = lower[at + id.length]
		if (!(before && /[0-9a-f-]/.test(before)) && !(after && /[0-9a-f-]/.test(after))) return true
		from = at + 1
	}
}

export type ChatYesFailure = {
	status: 403 | 404
	code: 'FORBIDDEN' | 'NOT_FOUND'
	message: string
	suggestion?: string
}

export type ChatYesResult =
	| { ok: true; messageId: number; conversationId: string; personId: string }
	| { ok: false; failure: ChatYesFailure }

const refuse = (
	status: ChatYesFailure['status'],
	code: ChatYesFailure['code'],
	message: string,
	suggestion?: string,
): ChatYesResult => ({ ok: false, failure: { status, code, message, suggestion } })

export async function verifyChatYes(
	db: Database,
	params: {
		workspaceId: string
		callerId: string
		messageId: number
		/** The id the chat must have shown before the person said yes. */
		targetId: string
		maxAgeMs: number
		now?: Date
	},
): Promise<ChatYesResult> {
	const { workspaceId, callerId, messageId, targetId } = params
	const now = params.now ?? new Date()
	const showAgain = `Post a message in this chat that names ${targetId} (link it), wait for the person's yes, then call this again with that message id.`

	const [message] = await db
		.select({
			id: messages.id,
			conversationId: messages.conversationId,
			actorId: messages.actorId,
			kind: messages.kind,
			createdAt: messages.createdAt,
			actorType: actors.type,
		})
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(eq(messages.id, messageId))
		.limit(1)
	if (!message) return refuse(404, 'NOT_FOUND', 'That chat message does not exist.')

	// The chat must belong to this workspace, and the calling agent must be in it.
	const participants = await db
		.select({ actorId: conversationParticipants.actorId })
		.from(conversationParticipants)
		.innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
		.where(
			and(
				eq(conversationParticipants.conversationId, message.conversationId),
				eq(conversations.workspaceId, workspaceId),
				isNull(conversationParticipants.leftAt),
			),
		)
	if (!participants.some((p) => p.actorId === callerId)) {
		return refuse(403, 'FORBIDDEN', 'You are not in the chat that message is in.')
	}

	if (message.kind !== 'message' || message.actorType !== 'human') {
		return refuse(
			403,
			'FORBIDDEN',
			"That message was not written by a person. Only a person's own message counts as approval.",
			'Ask the person to say yes in the chat, or to choose the option on a decision card.',
		)
	}
	const role = await getWorkspaceRole(db, message.actorId, workspaceId)
	if (role === null || role === 'viewer') {
		return refuse(
			403,
			'FORBIDDEN',
			'The person who wrote that message cannot approve in this workspace.',
		)
	}

	if (now.getTime() - message.createdAt.getTime() > params.maxAgeMs) {
		return refuse(403, 'FORBIDDEN', 'That message is too old to count. Ask the person again.')
	}

	// It must be the person's newest message in this chat, not an older one pulled back up.
	const [newest] = await db
		.select({ id: messages.id })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(
			and(
				eq(messages.conversationId, message.conversationId),
				eq(messages.kind, 'message'),
				eq(actors.type, 'human'),
			),
		)
		.orderBy(desc(messages.id))
		.limit(1)
	if (newest?.id !== message.id) {
		return refuse(
			403,
			'FORBIDDEN',
			'A person has written in this chat since that message. Only their latest message can count.',
			'Use the id of their latest message, or ask them to say yes again.',
		)
	}

	// The target was named here before the person answered.
	const earlier = await db
		.select({ id: messages.id, content: messages.content, editedAt: messages.editedAt })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, message.conversationId),
				eq(messages.kind, 'message'),
				gte(messages.createdAt, new Date(message.createdAt.getTime() - params.maxAgeMs)),
			),
		)
		.orderBy(desc(messages.id))
	// A naming message edited after the person replied does not count: the id could have been
	// slipped in once the answer was already in.
	const shown = earlier.some(
		(m) =>
			m.id < message.id &&
			(m.editedAt === null || m.editedAt <= message.createdAt) &&
			namesTarget(m.content, targetId),
	)
	if (!shown) {
		return refuse(
			403,
			'FORBIDDEN',
			'This chat did not name that agent before the message, so a yes there may be about something else.',
			showAgain,
		)
	}

	return {
		ok: true,
		messageId: message.id,
		conversationId: message.conversationId,
		personId: message.actorId,
	}
}
