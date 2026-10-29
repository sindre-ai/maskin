import type { MessageResponse, ReplyThreadParticipant, ReplyThreadSummary } from '@/lib/api'

/**
 * Whether a message belongs in the main timeline. The server returns replies
 * mixed into the newest-first pages, so the client keeps top-level messages and
 * the replies that were also sent to the channel.
 */
export function isTimelineMessage(
	message: Pick<MessageResponse, 'threadRootId' | 'threadAlsoInChannel'>,
): boolean {
	return message.threadRootId == null || message.threadAlsoInChannel === true
}

/**
 * The root a messages query key is scoped to: the numeric `thread_root_id` when
 * the filters object (index 4) carries one, otherwise null. Main-list keys
 * (`{ limit }`) and unrelated keys give null.
 */
export function threadRootOfQueryKey(key: readonly unknown[]): number | null {
	const filters = key[4]
	if (typeof filters !== 'object' || filters === null) return null
	const root = (filters as { thread_root_id?: unknown }).thread_root_id
	return typeof root === 'number' ? root : null
}

/**
 * Who a reply is addressed to by default: the root's author when it is an agent
 * other than the sender, otherwise the first agent participant other than the
 * sender. Agents only, never humans.
 */
export function defaultReplyRecipient(
	root: Pick<MessageResponse, 'actorId' | 'actorName' | 'actorType'>,
	participants: readonly ReplyThreadParticipant[],
	selfId: string | null | undefined,
): { id: string; name: string } | null {
	if (root.actorType === 'agent' && root.actorId !== selfId) {
		return { id: root.actorId, name: root.actorName }
	}
	const agent = participants.find((p) => p.actorType === 'agent' && p.actorId !== selfId)
	return agent ? { id: agent.actorId, name: agent.actorName } : null
}

/** "3 replies", or "2 new replies" when some are unread. */
export function replyPillLabel(
	summary: Pick<ReplyThreadSummary, 'replyCount' | 'unreadCount'>,
): string {
	const unread = summary.unreadCount > 0
	const count = unread ? summary.unreadCount : summary.replyCount
	return `${count} ${unread ? 'new ' : ''}${count === 1 ? 'reply' : 'replies'}`
}
