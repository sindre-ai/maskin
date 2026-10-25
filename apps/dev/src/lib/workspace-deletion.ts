import type { WorkspaceDeletionPreview } from '@maskin/shared'
import { type MembershipFacts, hasLiveSubscription } from './account-deletion'

/**
 * What stops this person deleting this workspace. Only the billing owner may, and not while a plan
 * is still being billed: deleting the workspace must not leave a subscription charging for nothing.
 */
export function workspaceDeletionPreview(
	actorId: string,
	actorType: string,
	facts: MembershipFacts,
): WorkspaceDeletionPreview {
	const blockers: WorkspaceDeletionPreview['blockers'] = []
	if (actorType !== 'human' || facts.billingOwnerId !== actorId) {
		blockers.push({
			code: 'not_billing_owner',
			message: 'Only the workspace’s billing owner can delete it.',
		})
	} else if (hasLiveSubscription(facts.billing)) {
		blockers.push({
			code: 'cancel_plan',
			message: `Cancel the plan on "${facts.workspaceName}" before deleting it.`,
		})
	}
	return {
		workspace_id: facts.workspaceId,
		workspace_name: facts.workspaceName,
		can_delete: blockers.length === 0,
		blockers,
		other_members: facts.otherHumanMembers,
	}
}
