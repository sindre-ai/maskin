import type { MessageResponse } from '@/lib/api'

type QuestionStateMessage = Pick<
	MessageResponse,
	'id' | 'actorId' | 'actorType' | 'kind' | 'metadata' | 'threadRootId' | 'threadAlsoInChannel'
> &
	Partial<Pick<MessageResponse, 'actorName' | 'createdAt' | 'content'>>

/** What an answered question keeps for its summary row: the pick, who gave it and when. */
export interface QuestionAnswer {
	/** The options picked per question (a dismissal reads `Dismissed`). Empty when the question was closed by typing. */
	picks: Array<{ header: string; selected: string[] }>
	/** The words typed, when a normal message closed the question instead of a pick. */
	text: string | null
	actorName: string | null
	createdAt: string | null
}

/** A pick counts only when it names at least one chosen option; an empty one answers nothing. */
function hasUsablePick(pick: { answers?: unknown }): boolean {
	const answers = pick.answers
	return (
		Array.isArray(answers) &&
		answers.some(
			(a) =>
				typeof a?.header === 'string' &&
				Array.isArray(a.selected) &&
				a.selected.some((label: unknown) => typeof label === 'string' && label !== ''),
		)
	)
}

/**
 * Which agent questions are answered, so their card collapses instead of inviting a second,
 * contradictory pick. A question is answered when:
 *
 * - any message carries a usable pick for it (`metadata.question_answer` with at least one chosen
 *   option, whoever sent it, a dismissal included). An empty or malformed one answers nothing, so
 *   the card is not hidden with no summary, or
 * - the viewer wrote a normal message after it, in the same place (the main chat, or the same
 *   thread), and it is the newest question still open at that moment. One reply closes one card:
 *   when an agent asks Q1 then Q2 and you answer Q2, Q1 stays open. Only the viewer's own message
 *   counts: in a chat with several people, someone else typing does not decide for you. A reply
 *   still sending (negative temporary id), a hidden card nudge, a helper's result and a system line
 *   are not replies.
 *
 * Helper questions (`reply_to_session`) are only ever answered by a pick: that conversation lives
 * in the helper's own thread.
 *
 * Messages compare by id, and only among the messages passed in, so an unloaded page never decides
 * anything: a question that is not loaded is not drawn, and a reply that is not loaded closes
 * nothing.
 *
 * Each answered id maps to what the summary row shows (the pick, or the typed words, plus who
 * answered and when). Where both a pick and a typed reply exist, the pick wins.
 */
export function answeredQuestionIds(
	messages: readonly QuestionStateMessage[],
	viewerId: string | undefined,
): Map<number, QuestionAnswer> {
	const answered = new Map<number, QuestionAnswer>()
	for (const m of messages) {
		const pick = m.metadata?.question_answer
		if (pick && typeof pick.question_message_id === 'number' && hasUsablePick(pick)) {
			if (answered.has(pick.question_message_id)) continue
			answered.set(pick.question_message_id, {
				picks: pick.answers,
				text: null,
				actorName: m.actorName ?? null,
				createdAt: m.createdAt ?? null,
			})
		}
	}
	if (!viewerId) return answered

	const replies: { id: number; place: number | null; message: QuestionStateMessage }[] = []
	const questions: { id: number; place: number | null }[] = []
	for (const m of messages) {
		const place = m.threadRootId ?? null
		const question = m.metadata?.question
		if (question) {
			if (!question.reply_to_session) questions.push({ id: m.id, place })
			continue
		}
		const isTypedReply =
			m.id > 0 &&
			m.actorType === 'human' &&
			m.actorId === viewerId &&
			m.kind === 'message' &&
			!m.metadata?.hidden_from_chat &&
			!m.metadata?.helper_return &&
			!m.metadata?.question_answer
		if (isTypedReply) replies.push({ id: m.id, place, message: m })
	}

	// Oldest reply first, each closing the newest question in its place that is still open.
	replies.sort((a, b) => a.id - b.id)
	for (const reply of replies) {
		let target: number | null = null
		for (const q of questions) {
			if (q.place !== reply.place || q.id >= reply.id || answered.has(q.id)) continue
			if (target === null || q.id > target) target = q.id
		}
		if (target !== null) {
			answered.set(target, {
				picks: [],
				text: reply.message.content ?? null,
				actorName: reply.message.actorName ?? null,
				createdAt: reply.message.createdAt ?? null,
			})
		}
	}
	return answered
}
