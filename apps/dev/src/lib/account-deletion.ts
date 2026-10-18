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
	// `canceled` and `incomplete_expired` are Stripe's terminal states: nothing more will be billed.
	// Every other status (including `unpaid`, which can still be revived) keeps blocking.
	return billing.status !== 'canceled' && billing.status !== 'incomplete_expired'
}

/** Nobody else human is in the workspace, so it is the one the person can take with them. */
export function isSoleHuman(m: Pick<MembershipFacts, 'otherHumanMembers'>): boolean {
	return m.otherHumanMembers === 0
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
	options: { deleteSoleWorkspaces?: boolean } = {},
): AccountDeletionPreview {
	const blockers: AccountDeletionBlocker[] = []
	for (const m of memberships) {
		// A workspace that will be deleted with the account takes its plan with it, whoever pays:
		// the subscription must be cancelled first or it would bill a workspace that no longer exists.
		if (options.deleteSoleWorkspaces && isSoleHuman(m) && m.billingOwnerId !== actorId) {
			if (hasLiveSubscription(m.billing)) {
				blockers.push({
					code: 'cancel_plan',
					workspace_id: m.workspaceId,
					workspace_name: m.workspaceName,
				})
			}
			continue
		}
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
			will_delete: isSoleHuman(m),
		})),
	}
}
