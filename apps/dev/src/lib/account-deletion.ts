import type { AccountDeletionBlocker, AccountDeletionPreview } from '@maskin/shared'

/** One workspace the person belongs to, with just what deletion needs to decide. */
export interface MembershipFacts {
	workspaceId: string
	workspaceName: string
	billingOwnerId: string | null
	/** Human members other than the person. */
	otherHumanMembers: number
	/** `workspaces.settings.billing`, read defensively: a malformed settings blob must not hide a
	 * subscription (and so let billing outlive the account). */
	billing: { stripe_subscription_id?: unknown; status?: unknown } | null
}

/** A plan that is still being billed: a Stripe subscription that hasn't been cancelled. */
export function hasLiveSubscription(billing: MembershipFacts['billing']): boolean {
	if (!billing) return false
	const id = billing.stripe_subscription_id
	if (typeof id !== 'string' || id.length === 0) return false
	return billing.status !== 'canceled'
}

/**
 * What stops this person deleting their account.
 *
 * Only the BILLING OWNER of a workspace blocks deletion, because only they are the accountable
 * payer: with other people in it the workspace needs a new owner first, and with a live plan the
 * plan must be cancelled so charges don't continue for an account that no longer exists. Being an
 * ordinary member or an owner of a free workspace never blocks.
 */
export function accountDeletionPreview(
	actorId: string,
	memberships: MembershipFacts[],
): AccountDeletionPreview {
	const blockers: AccountDeletionBlocker[] = []
	for (const m of memberships) {
		if (m.billingOwnerId !== actorId) continue
		if (m.otherHumanMembers > 0) {
			blockers.push({
				code: 'transfer_ownership',
				workspace_id: m.workspaceId,
				workspace_name: m.workspaceName,
			})
		} else if (hasLiveSubscription(m.billing)) {
			blockers.push({
				code: 'cancel_plan',
				workspace_id: m.workspaceId,
				workspace_name: m.workspaceName,
			})
		}
	}
	return {
		can_delete: blockers.length === 0,
		blockers,
		leaving: memberships.map((m) => ({
			workspace_id: m.workspaceId,
			workspace_name: m.workspaceName,
			other_members: m.otherHumanMembers,
		})),
	}
}
