import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	messages,
	objects,
} from '@maskin/db/schema'
import type { ObjectPreview } from '@maskin/shared'
import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { findCurrentApproval, recordObjectApproval } from './object-delivery'
import { buildObjectPreview } from './object-preview'
import { getWorkspaceRole } from './workspace-auth'

/**
 * A person's "send it" in a chat, counted as the Approve on a draft.
 *
 * The server never takes the agent's word that a person said yes. It reads the message the
 * agent names and records the approval only when every one of these holds:
 *
 *  - the caller is an agent that is in the chat the message sits in;
 *  - the message was written by a person who can write in the workspace (never an agent);
 *  - it is that person's newest message in the chat, so an older "thanks" cannot be cited;
 *  - it was posted after the draft's last edit;
 *  - the draft was shown in that chat: an earlier message there links the object (the chat
 *    draws a live card for the link), and it was posted after the draft's last edit too. A
 *    showing message that was edited after the person's reply does not count.
 *
 * What the server cannot tell is whether the person's words mean yes. It proves who wrote
 * them, where, and that they saw the current text. The approval is recorded under the
 * person's actor id (the send gate only honours approvals written by a person), with
 * `via: 'chat'` and the message id so it can be audited. The send claim keyed on the
 * approval keeps it to one send, and any later edit changes the content hash, which
 * withdraws it, exactly as for the button.
 *
 * Every kind that has a send tool honouring an approval is listed in CHAT_APPROVABLE_KINDS:
 * email, the LinkedIn kinds and Slack messages. Their send tools read the same `approved`
 * event the card's button writes, so a chat approval unlocks them the same way. A kind is added
 * only when its send path reads that event.
 */

export const CHAT_APPROVABLE_KINDS: ReadonlySet<string> = new Set([
	'email',
	'linkedin_message',
	'linkedin_connection_request',
	'linkedin_inmail',
	'linkedin_post',
	'linkedin_comment',
	'linkedin_comment_reply',
	'linkedin_post_edit',
	'slack_message',
])

const OBJECT_LINK =
	/\/objects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/gi
const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g
const INLINE_CODE = /(`+)[^`\n][\s\S]*?\1(?!`)/g

/** True when the message links the object outside code, the way the chat decides to draw a card. */
function linksObject(content: string, objectId: string): boolean {
	const text = content.replace(FENCED_CODE, '$1').replace(INLINE_CODE, '')
	for (const match of text.matchAll(OBJECT_LINK)) {
		if (match[1]?.toLowerCase() === objectId.toLowerCase()) return true
	}
	return false
}

export type ChatApprovalFailure = {
	status: 400 | 403 | 404
	code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND'
	message: string
	suggestion?: string
}

export type ChatApprovalResult =
	| { ok: true; approvalId: number; alreadyApproved: boolean; preview: ObjectPreview }
	| { ok: false; failure: ChatApprovalFailure }

const refuse = (
	status: ChatApprovalFailure['status'],
	code: ChatApprovalFailure['code'],
	message: string,
	suggestion?: string,
): ChatApprovalResult => ({ ok: false, failure: { status, code, message, suggestion } })

const SHOW_AGAIN =
	'Post a message in this chat that links the draft so the person sees its current text, wait for their yes, then call this again with that message id.'

export async function approveDraftFromChat(
	db: Database,
	params: { workspaceId: string; callerId: string; objectId: string; messageId: number },
): Promise<ChatApprovalResult> {
	const { workspaceId, callerId, objectId, messageId } = params

	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, objectId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!object) return refuse(404, 'NOT_FOUND', 'That object does not exist.')

	const preview = buildObjectPreview(object)
	if (!preview || !CHAT_APPROVABLE_KINDS.has(preview.kind)) {
		return refuse(
			400,
			'BAD_REQUEST',
			'Only a draft that has a send tool (an email, a LinkedIn message, post, comment or invitation, or a Slack message) can be approved from a chat message.',
			'Ask the person to press Approve on the card.',
		)
	}
	if (preview.missing.length > 0) {
		return refuse(
			400,
			'BAD_REQUEST',
			`It cannot be approved yet. Missing: ${preview.missing.join(', ')}.`,
		)
	}

	// Already approved at exactly this text (the button, or this same call before): nothing to add.
	const existing = await findCurrentApproval(db, workspaceId, objectId, preview.content_hash)
	if (existing) {
		return { ok: true, approvalId: existing.id, alreadyApproved: true, preview }
	}

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
			'Ask the person to say yes in the chat, or to press Approve on the card.',
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

	const editedAt = object.updatedAt ?? object.createdAt
	if (editedAt && message.createdAt < editedAt) {
		return refuse(
			403,
			'FORBIDDEN',
			'That message is older than the last edit to the draft, so the person did not see this text when they wrote it.',
			SHOW_AGAIN,
		)
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

	// The draft was shown here, after its last edit and before the person answered.
	const shown = await db
		.select({ id: messages.id, content: messages.content, editedAt: messages.editedAt })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, message.conversationId),
				eq(messages.kind, 'message'),
				...(editedAt ? [gte(messages.createdAt, editedAt)] : []),
			),
		)
		.orderBy(desc(messages.id))
	// A showing message edited after the person replied does not count: the link could have been
	// slipped in once the answer was already in.
	const previewShown = shown.some(
		(m) =>
			m.id < message.id &&
			(m.editedAt === null || m.editedAt <= message.createdAt) &&
			linksObject(m.content, objectId),
	)
	if (!previewShown) {
		return refuse(
			403,
			'FORBIDDEN',
			'The draft was not shown in this chat before that message, so a yes there may be about something else.',
			SHOW_AGAIN,
		)
	}

	const approval = await recordObjectApproval(db, {
		workspaceId,
		actorId: message.actorId,
		objectId,
		objectType: object.type,
		preview,
		via: 'chat',
		chat: { messageId: message.id, conversationId: message.conversationId, agentId: callerId },
	})
	return { ok: true, approvalId: Number(approval.id), alreadyApproved: false, preview }
}
