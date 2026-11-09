import type { MessageResponse } from '@/lib/api'

type QuestionStateMessage = Pick<
	MessageResponse,
	'id' | 'actorId' | 'actorType' | 'kind' | 'metadata' | 'threadRootId' | 'threadAlsoInChannel'
>

/**
 * Which agent questions are answered, so their card collapses instead of inviting a second,
 * contradictory pick. A question is answered when:
 *
 * - any later message carries a pick for it (`metadata.question_answer`, whoever sent it, a
 *   dismissal included), or
 * - the viewer wrote a normal message after it, in the same place (the main chat, or the same
 *   thread). Only the viewer's own message counts: in a chat with several people, someone else
 *   typing does not decide for you. A reply still sending (negative temporary id), a hidden card
 *   nudge, a helper's result and a system line are not replies.
 *
 * Helper questions (`reply_to_session`) are only ever answered by a pick: that conversation lives
 * in the helper's own thread.
 *
 * Messages compare by id, and only among the messages passed in, so an unloaded page never decides
 * anything: a question that is not loaded is not drawn, and a reply that is not loaded closes
 * nothing.
 */
export function answeredQuestionIds(
	messages: readonly QuestionStateMessage[],
	viewerId: string | undefined,
): Set<number> {
	const answered = new Set<number>()
	for (const m of messages) {
		const picked = m.metadata?.question_answer?.question_message_id
		if (typeof picked === 'number') answered.add(picked)
	}
	if (!viewerId) return answered

	// Newest typed reply by the viewer in each place; null is the main chat.
	const newestTyped = new Map<number | null, number>()
	for (const m of messages) {
		const isTypedReply =
			m.id > 0 &&
			m.actorType === 'human' &&
			m.actorId === viewerId &&
			m.kind === 'message' &&
			!m.metadata?.hidden_from_chat &&
			!m.metadata?.helper_return &&
			!m.metadata?.question_answer
		if (!isTypedReply) continue
		const place = m.threadRootId ?? null
		if (m.id > (newestTyped.get(place) ?? 0)) newestTyped.set(place, m.id)
	}

	for (const m of messages) {
		const question = m.metadata?.question
		if (!question || question.reply_to_session) continue
		const reply = newestTyped.get(m.threadRootId ?? null)
		if (reply !== undefined && m.id < reply) answered.add(m.id)
	}
	return answered
}
