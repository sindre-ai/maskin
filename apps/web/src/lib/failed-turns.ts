import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'

/** An agent's end-of-turn notice for a turn that failed (model API error, empty or unanswered turn). */
function isFailedReply(message: MessageResponse): boolean {
	if (message.actorType !== 'agent' || message.kind !== 'message') return false
	const output = message.metadata?.final_output
	return Boolean(output && (output.is_error || output.error_kind))
}

/** What had already failed when the person pressed redo. Anything newer is the new attempt and stays visible. */
export interface RedoSnapshot {
	/** Highest message id in the thread at redo time. */
	upToMessageId: number
	/** Failed sessions under the redone message at redo time. */
	failedSessionIds: ReadonlySet<string>
}

/** Redone turns, keyed by the id of the message the turn answers (see `redoKey`). */
export type RedoneTurns = ReadonlyMap<number, RedoSnapshot>

/**
 * The key a redo is stored under: the message the turn answers. Retrying an
 * agent's own failed reply redoes the turn that reply belonged to.
 */
export function redoKey(message: MessageResponse): number {
	return message.metadata?.final_output?.message_id ?? message.id
}

export function snapshotRedo(
	messages: MessageResponse[],
	turnsUnderMessage: MessageTurnActivity[],
): RedoSnapshot {
	return {
		upToMessageId: messages.reduce((max, m) => Math.max(max, m.id), 0),
		failedSessionIds: new Set(turnsUnderMessage.filter((t) => t.failed).map((t) => t.sessionId)),
	}
}

/**
 * Ids of failed-turn notices the timeline should no longer show because the
 * turn was tried again: the person redid it in this view and the notice
 * already existed when they did (`redoneTurns`), or a later reply from the
 * same agent now answers the same message. A failure newer than the redo is
 * the new attempt and stays. Display only; the messages and their sessions
 * stay in the audit trail.
 */
export function supersededFailedReplyIds(
	messages: MessageResponse[],
	redoneTurns: RedoneTurns,
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
		const snapshot = redoneTurns.get(triggerId ?? message.id)
		const redone = snapshot != null && message.id <= snapshot.upToMessageId
		const replaced =
			triggerId != null && (latestByTurn.get(`${message.actorId}:${triggerId}`) ?? 0) > message.id
		if (redone || replaced) hidden.add(message.id)
	}
	return hidden
}

/** A failed session's pill under a redone message no longer applies: the new attempt takes its place. A failed session newer than the redo stays. */
export function dropRedoneFailedTurns(
	turns: MessageTurnActivity[],
	triggerMessageId: number,
	redoneTurns: RedoneTurns,
): MessageTurnActivity[] {
	const snapshot = redoneTurns.get(triggerMessageId)
	if (!snapshot) return turns
	return turns.filter((turn) => !(turn.failed && snapshot.failedSessionIds.has(turn.sessionId)))
}
