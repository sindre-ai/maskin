import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export type MentionGuardResult = 'allowed' | 'blocked'

export type MentionGuardReason =
	| 'ok'
	| 'mention_capped'
	| 'mention_duplicate'
	| 'return_capped'
	| 'hop_cap'

export interface MentionGuardDecisionProps {
	workspaceId: string
	/** Actor the guard was protecting, i.e. the one that would have been woken. */
	targetActorId: string
	objectId: string
	result: MentionGuardResult
	reason: MentionGuardReason
	/** The comment event that carried the mention, when there is one. */
	sourceCommentEventId?: number
}

/**
 * Fires on every guard decision, allowed or blocked, so the guard numbers in
 * `services/mention-guards.ts` can be retuned from real counts after a week.
 * Best-effort: a capture failure never blocks dispatch.
 */
export async function trackMentionGuardDecision(p: MentionGuardDecisionProps): Promise<void> {
	try {
		await capturePosthogEvent('mention_guard_decision', p.targetActorId, {
			workspace_id: p.workspaceId,
			object_id: p.objectId,
			result: p.result,
			reason: p.reason,
			source_comment_event_id: p.sourceCommentEventId ?? null,
		})
	} catch (err) {
		logger.warn('Failed to emit mention_guard_decision', {
			reason: p.reason,
			error: String(err),
		})
	}
}
