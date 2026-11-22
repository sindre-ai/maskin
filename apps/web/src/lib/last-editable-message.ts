import type { MessageResponse } from '@/lib/api'

/**
 * The message the up arrow in an empty box opens for editing: the newest of the person's own
 * top-level messages that has words to edit. An optimistic bubble, a system row, a deleted
 * message, a reply inside a thread and a message that is only attachments are passed over.
 * `messages` is oldest first.
 */
export function findLastEditableMessage(
	messages: readonly MessageResponse[],
	actorId: string | undefined,
): MessageResponse | null {
	if (!actorId) return null
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.actorId !== actorId) continue
		if (m.id <= 0 || m.kind !== 'message' || m.deletedAt) continue
		if (m.threadRootId != null && !m.threadAlsoInChannel) continue
		if (m.content.length === 0) continue
		return m
	}
	return null
}
