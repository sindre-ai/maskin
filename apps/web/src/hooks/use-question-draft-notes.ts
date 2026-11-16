import { api } from '@/lib/api'
import type { MessageQuestion } from '@/lib/api'
import { extractLinkedObjectIds, showsObjectCard } from '@/lib/linked-objects'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

/** What an agent asked, kept as a short note in the card of the draft it asked about. */
export interface QuestionDraftNote {
	question: string
	reason?: string
}

/**
 * Approve and Skip can answer one single-choice question with at most two options. Anything
 * more (several questions, several answers, a third option) keeps its own question card.
 */
function askedAsYesNo(question: MessageQuestion): boolean {
	return (
		question.questions.length === 1 &&
		question.questions.every((q) => !q.multi_select && q.options.length <= 2)
	)
}

/**
 * When one message links a draft that can still be approved and also asks a question, the draft
 * card carries the question and the question card is not drawn: one decision, one card. Returns
 * the draft's id and the note, or nothing when the message links no such draft. `heldElsewhere`
 * are links another message draws the card for; those are chips here, so there is no card to hold
 * the note and the question card stays.
 */
export function useQuestionDraftNote(
	workspaceId: string,
	content: string,
	question: MessageQuestion | undefined,
	heldElsewhere: ReadonlySet<string> | undefined,
): { draftId: string; note: QuestionDraftNote } | null {
	const ids = useMemo(
		() =>
			question && !question.reply_to_session && askedAsYesNo(question)
				? extractLinkedObjectIds(content).filter((id) => !heldElsewhere?.has(id))
				: [],
		[question, content, heldElsewhere],
	)
	const objects = useQueries({
		queries: ids.map((id) => ({
			queryKey: queryKeys.objects.detail(id),
			queryFn: () => api.objects.get(id),
		})),
	})
	return useMemo(() => {
		if (!question) return null
		const index = objects.findIndex(
			(q) =>
				showsObjectCard(q.data, workspaceId) &&
				(q.data?.preview?.delivery?.state ?? 'draft') === 'draft',
		)
		if (index < 0) return null
		// Agents put the option they suggest first, with the reason in its description.
		const asked = question.questions.map((q) => q.question).join(' ')
		const reason = question.questions[0]?.options[0]?.description
		return { draftId: ids[index], note: { question: asked, ...(reason ? { reason } : {}) } }
	}, [objects, ids, question, workspaceId])
}
