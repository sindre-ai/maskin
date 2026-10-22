import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'

/** An agent's end-of-turn notice for a turn that failed (model API error, empty or unanswered turn). */
function isFailedReply(message: MessageResponse): boolean {
	if (message.actorType !== 'agent' || message.kind !== 'message') return false
	const output = message.metadata?.final_output
	return Boolean(output && (output.is_error || output.error_kind))
}

/**
 * Ids of failed-turn notices the timeline should no longer show because the
 * turn was tried again: the person redid it in this view (`redoneMessageIds`
 * holds the message they redid), or a later reply from the same agent now
 * answers the same message. Display only; the messages and their sessions stay
 * in the audit trail.
 */
export function supersededFailedReplyIds(
	messages: MessageResponse[],
	redoneMessageIds: ReadonlySet<number>,
): Set<number> {
	const hidden = new Set<number>()
	const latestByTurn = new Map<string, number>()
	for (const message of messages) {
		const triggerId = message.metadata?.final_output?.message_id
		if (message.actorType !== 'agent' || triggerId == null) continue
		latestByTurn.set(`${message.actorId}:${triggerId}`, message.id)
	}
	for (const message of messages) {
		if (!isFailedReply(message)) continue
		const triggerId = message.metadata?.final_output?.message_id
		const redone =
			redoneMessageIds.has(message.id) || (triggerId != null && redoneMessageIds.has(triggerId))
		const replaced =
			triggerId != null && (latestByTurn.get(`${message.actorId}:${triggerId}`) ?? 0) > message.id
		if (redone || replaced) hidden.add(message.id)
	}
	return hidden
}

/** A failed session's pill under a message the person has redone no longer applies: the new attempt takes its place. */
export function dropRedoneFailedTurns(
	turns: MessageTurnActivity[],
	triggerMessageId: number,
	redoneMessageIds: ReadonlySet<number>,
): MessageTurnActivity[] {
	if (!redoneMessageIds.has(triggerMessageId)) return turns
	return turns.filter((turn) => !turn.failed)
}
