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
	decision: 'accepted' | 'edited_then_accepted' | 'rejected'
}

/**
 * A person decided one proposed change. Sent by the server after the decision
 * has committed, never from the browser, one event per change. A refused call
 * (403, or 409 because a change went stale) sends nothing here.
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
