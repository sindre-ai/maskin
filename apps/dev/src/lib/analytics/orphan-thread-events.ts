import { capturePosthogEvent } from './posthog'

export type OrphanThreadKind = 'decision_required' | 'question' | 'flag'

export interface OrphanThreadDetectedProps {
	workspaceId: string
	objectId: string
	rootCommentEventId: number
	expectedReplyActorId: string
	hoursWithoutReply: number
	threadKind: OrphanThreadKind
}

export async function trackOrphanThreadDetected(p: OrphanThreadDetectedProps): Promise<void> {
	await capturePosthogEvent('orphan_thread_detected', p.expectedReplyActorId, {
		workspace_id: p.workspaceId,
		object_id: p.objectId,
		root_comment_event_id: p.rootCommentEventId,
		expected_reply_actor_id: p.expectedReplyActorId,
		hours_without_reply: p.hoursWithoutReply,
		thread_kind: p.threadKind,
	})
}
