import { describe, expect, it } from 'vitest'
import {
	type MembershipFacts,
	accountDeletionPreview,
	hasLiveSubscription,
} from '../../lib/account-deletion'

const ME = 'me'

function membership(overrides: Partial<MembershipFacts> = {}): MembershipFacts {
	return {
		workspaceId: '00000000-0000-4000-8000-000000000001',
		workspaceName: 'Acme',
		billingOwnerId: ME,
		otherHumanMembers: 0,
		billing: null,
		...overrides,
	}
}

describe('hasLiveSubscription', () => {
	it('is false with no billing or no subscription id', () => {
		expect(hasLiveSubscription(null)).toBe(false)
		expect(hasLiveSubscription({})).toBe(false)
		expect(hasLiveSubscription({ stripe_subscription_id: '' })).toBe(false)
		expect(hasLiveSubscription({ stripe_subscription_id: 42 })).toBe(false)
	})

	it('is true for a subscription that has not been cancelled, whatever else is odd about it', () => {
		expect(hasLiveSubscription({ stripe_subscription_id: 'sub_1' })).toBe(true)
		expect(hasLiveSubscription({ stripe_subscription_id: 'sub_1', status: 'active' })).toBe(true)
		expect(hasLiveSubscription({ stripe_subscription_id: 'sub_1', status: 'past_due' })).toBe(true)
		expect(hasLiveSubscription({ stripe_subscription_id: 'sub_1', status: 'canceled' })).toBe(false)
	})
})

describe('accountDeletionPreview', () => {
	it('allows deleting when you only belong to workspaces you do not pay for', () => {
		const preview = accountDeletionPreview(ME, [
			membership({ billingOwnerId: 'someone-else', otherHumanMembers: 3 }),
		])
		expect(preview.can_delete).toBe(true)
		expect(preview.blockers).toEqual([])
		expect(preview.leaving).toEqual([
			{ workspace_id: expect.any(String), workspace_name: 'Acme', other_members: 3 },
		])
	})

	it('allows deleting a free workspace you alone use', () => {
		expect(accountDeletionPreview(ME, [membership()]).can_delete).toBe(true)
	})

	it('allows deleting with no memberships at all', () => {
		const preview = accountDeletionPreview(ME, [])
		expect(preview.can_delete).toBe(true)
		expect(preview.leaving).toEqual([])
	})

	it('blocks you paying for a workspace others use: transfer ownership first', () => {
		const preview = accountDeletionPreview(ME, [membership({ otherHumanMembers: 2 })])
		expect(preview.can_delete).toBe(false)
		expect(preview.blockers).toEqual([
			{ code: 'transfer_ownership', workspace_id: expect.any(String), workspace_name: 'Acme' },
		])
	})

	it('blocks you paying for a live plan on a workspace you alone use: cancel it first', () => {
		const preview = accountDeletionPreview(ME, [
			membership({ billing: { stripe_subscription_id: 'sub_1', status: 'active' } }),
		])
		expect(preview.blockers.map((b) => b.code)).toEqual(['cancel_plan'])
	})

	it('transfer takes precedence over cancel when others use a paid workspace', () => {
		const preview = accountDeletionPreview(ME, [
			membership({
				otherHumanMembers: 1,
				billing: { stripe_subscription_id: 'sub_1', status: 'active' },
			}),
		])
		expect(preview.blockers.map((b) => b.code)).toEqual(['transfer_ownership'])
	})

	it('does not block on a plan someone else pays for', () => {
		const preview = accountDeletionPreview(ME, [
			membership({
				billingOwnerId: 'someone-else',
				billing: { stripe_subscription_id: 'sub_1', status: 'active' },
			}),
		])
		expect(preview.can_delete).toBe(true)
	})

	it('reports every blocking workspace, not just the first', () => {
		const preview = accountDeletionPreview(ME, [
			membership({
				workspaceId: '00000000-0000-4000-8000-000000000001',
				workspaceName: 'A',
				otherHumanMembers: 1,
			}),
			membership({
				workspaceId: '00000000-0000-4000-8000-000000000002',
				workspaceName: 'B',
				billing: { stripe_subscription_id: 'sub_9' },
			}),
		])
		expect(preview.blockers.map((b) => `${b.workspace_name}:${b.code}`)).toEqual([
			'A:transfer_ownership',
			'B:cancel_plan',
		])
	})
})
