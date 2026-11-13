import { DecisionOptions } from '@/components/shared/decision-option-card'
import { useCreateComment } from '@/hooks/use-events'
import { secondsSince, trackForyouCardAction } from '@/lib/analytics'
import type { EventResponse } from '@/lib/api'
import { decisionOfEvent } from '@/lib/comment-decision'
import { actionIdFromLabel } from '@/lib/foryou-card-kind'
import { Check } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

/**
 * The options an agent attached to a comment, rendered on the object timeline.
 *
 * For You was briefly the only surface that drew these, while the timeline
 * still marked the comment as a decision point — so a reader who opened the ask
 * on the object it was posted to saw "Needs you" and no way to answer, and the
 * options of a decision they had already been shown in the feed simply were not
 * there. The same options render on both surfaces now, from the same component.
 *
 * Taking an option posts the label as a reply threaded under the ask, exactly
 * as the feed does: the agent that asked reads the answer off `parent_event_id`
 * rather than inferring it from timing.
 */
export function CommentDecisionBlock({
	event,
	workspaceId,
	objectId,
	// Replies already on this comment. An option the reader has taken shows the
	// question as answered rather than offering it again — the buttons post a
	// real comment, and a second tap would post a second, contradictory answer.
	replies = [],
}: {
	event: EventResponse
	workspaceId: string
	objectId: string
	replies?: EventResponse[]
}) {
	const decision = decisionOfEvent(event)
	const createComment = useCreateComment(workspaceId, objectId)
	const [pendingId, setPendingId] = useState<string | null>(null)

	const options = useMemo(() => {
		if (!decision) return []
		return decision.options.map((option) => ({
			id: actionIdFromLabel(option.label),
			label: option.label,
			consequences: option.consequences,
			recommended: option.recommended,
		}))
	}, [decision])

	// An answer is a reply whose text is one of the option labels. Comparing on
	// the label rather than on authorship means a teammate's answer settles the
	// question too — the agent asked the thread, not one person.
	const answer = useMemo(() => {
		if (!decision) return null
		const labels = new Set(decision.options.map((option) => option.label.toLowerCase()))
		const match = replies.find((reply) => {
			const content = reply.data?.content
			return typeof content === 'string' && labels.has(content.trim().toLowerCase())
		})
		return typeof match?.data?.content === 'string' ? match.data.content.trim() : null
	}, [decision, replies])

	const choose = useCallback(
		(option: { id: string; label: string }) => {
			if (pendingId) return
			trackForyouCardAction({
				card_kind: 'decision',
				card_id: objectId,
				action_id: option.id,
				seconds_to_action: secondsSince(event.createdAt),
				session_id:
					typeof event.data?.authorSessionId === 'string' ? event.data.authorSessionId : null,
			})
			setPendingId(option.id)
			createComment.mutate(
				{
					entity_id: objectId,
					content: option.label,
					parent_event_id: event.id,
				},
				// The hook toasts on error and the reply lands in the timeline on
				// success, so there is nothing to say here beyond releasing the
				// buttons. Released on both paths: a failed answer the reader cannot
				// retry is worse than one they can.
				{ onSettled: () => setPendingId(null) },
			)
		},
		[createComment, event, objectId, pendingId],
	)

	if (!decision || options.length === 0) return null

	if (answer) {
		return (
			<div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
				<Check size={13} className="shrink-0 text-success" aria-hidden />
				<span>
					Answered: <span className="text-foreground font-semibold">{answer}</span>
				</span>
			</div>
		)
	}

	return (
		<div className="mt-2.5 flex flex-col gap-2.5">
			{decision.ask && (
				<p className="text-foreground text-pretty text-[13px] font-semibold leading-[1.5]">
					{decision.ask}
				</p>
			)}
			<DecisionOptions options={options} pendingId={pendingId} onChoose={choose} />
		</div>
	)
}
