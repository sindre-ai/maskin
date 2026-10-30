import { capturePosthogEvent } from './posthog'

interface ChangeProposalSubmittedProps {
	workspaceId: string
	actorId: string
	fileName: string
	proposalId: string
	changeCount: number
}

/**
 * An agent's change proposal was stored. Sent by the server after the proposal
 * has committed, never from the browser, and only for a submit that succeeded:
 * a rejected submit sends nothing. The other two review events
 * (change_reviewed, change_review_opened) belong to the tasks that build them.
 */
export async function trackChangeProposalSubmitted(p: ChangeProposalSubmittedProps): Promise<void> {
	await capturePosthogEvent('change_proposal_submitted', p.actorId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		file_name: p.fileName,
		proposal_id: p.proposalId,
		change_count: p.changeCount,
	})
}

interface ChangeReviewedProps {
	workspaceId: string
	actorId: string
	fileName: string
	proposalId: string
	changeId: string
	decision: 'accepted' | 'edited_then_accepted' | 'rejected' | 'stale'
}

/**
 * A person decided one proposed change. Sent by the server after the decision
 * has committed, never from the browser, one event per change. A refused call
 * sends nothing here, except a bulk accept refused with 409 because changes went
 * stale: that sends one event with decision stale per stale change, and none for
 * the changes that were still pending.
 */
export async function trackChangeReviewed(p: ChangeReviewedProps): Promise<void> {
	await capturePosthogEvent('change_reviewed', p.actorId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		file_name: p.fileName,
		proposal_id: p.proposalId,
		change_id: p.changeId,
		decision: p.decision,
	})
}
