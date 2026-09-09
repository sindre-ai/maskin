import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export type CommentResponderCase =
	| 'case_1_mention'
	| 'case_1_agent_thread_reply'
	| 'case_2_driver_fallback'
	| 'case_3_cos_fallback'
	| 'noop_self_authored'
	| 'noop_suppressed'
	| 'noop_no_responder'

export interface CommentResponderResolvedProps {
	workspaceId: string
	sourceCommentEventId: number
	commentAuthorId: string
	case: CommentResponderCase
	/** The actor the resolver dispatched to. Null for the noop case. */
	resolvedActorId: string | null
}

/**
 * Fires once per handled comment_posted (DB action `commented`) event from the
 * always-a-responder fallback resolver. Distinct id is the resolved actor when
 * present, otherwise the comment author — so PostHog can attribute the drop in
 * `orphan_thread_detected` to specific resolver cases in aggregate.
 *
 * Best-effort: any capture failure is swallowed so analytics never blocks
 * dispatch.
 */
export async function trackCommentResponderResolved(
	p: CommentResponderResolvedProps,
): Promise<void> {
	try {
		const distinctId = p.resolvedActorId ?? p.commentAuthorId
		await capturePosthogEvent('comment_responder_resolved', distinctId, {
			workspace_id: p.workspaceId,
			source_comment_event_id: p.sourceCommentEventId,
			case: p.case,
			resolved_actor_id: p.resolvedActorId,
		})
	} catch (err) {
		logger.warn('Failed to emit comment_responder_resolved', {
			sourceCommentEventId: p.sourceCommentEventId,
			case: p.case,
			error: String(err),
		})
	}
}
