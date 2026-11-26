import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export interface OutcomeCheckedProps {
	workspaceId: string
	/** The agent that asked to close, or the person who ended the check; the distinct id. */
	actorId: string
	objectType: string
	/** One of the five endings, or waiting_for_person for a round that decided nothing. */
	ending: string
	/** The round's number; null for a round that only waits for a person, and for a person's ending. */
	round: number | null
	/** Who marked lines: code, checker, person. */
	checkedBy: string[]
	/** The read-only-run flag was set. */
	flagged: boolean
}

/**
 * One event per outcome check round. Counts, categories and ids only: never a line's text, a
 * reading's value, the job's title or the checker's reason. Best-effort: never throws, so callers
 * fire it without awaiting.
 */
export async function trackOutcomeChecked(p: OutcomeCheckedProps): Promise<void> {
	try {
		await capturePosthogEvent('outcome_checked', p.actorId, {
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
			object_type: p.objectType,
			ending: p.ending,
			round: p.round,
			checked_by: p.checkedBy,
			flagged: p.flagged,
		})
	} catch (err) {
		logger.warn('Failed to emit outcome_checked', { actorId: p.actorId, error: String(err) })
	}
}
