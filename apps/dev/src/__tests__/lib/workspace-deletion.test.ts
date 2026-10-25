import { describe, expect, it } from 'vitest'
import type { MembershipFacts } from '../../lib/account-deletion'
import { workspaceDeletionPreview } from '../../lib/workspace-deletion'

const ME = 'me'

function facts(overrides: Partial<MembershipFacts> = {}): MembershipFacts {
	return {
		workspaceId: '00000000-0000-4000-8000-000000000001',
		workspaceName: 'Acme',
		billingOwnerId: ME,
		otherHumanMembers: 2,
		billing: null,
		...overrides,
	}
}

describe('workspaceDeletionPreview', () => {
	it('lets the billing owner delete a free workspace and reports who loses access', () => {
		expect(workspaceDeletionPreview(ME, 'human', facts())).toEqual({
			workspace_id: '00000000-0000-4000-8000-000000000001',
			workspace_name: 'Acme',
			can_delete: true,
			blockers: [],
			other_members: 2,
		})
	})

	it('blocks anyone but the billing owner', () => {
		const preview = workspaceDeletionPreview('member', 'human', facts())
		expect(preview.can_delete).toBe(false)
		expect(preview.blockers.map((b) => b.code)).toEqual(['not_billing_owner'])
	})

	it('blocks an agent even when it is recorded as the billing owner', () => {
		const preview = workspaceDeletionPreview(ME, 'agent', facts())
		expect(preview.blockers.map((b) => b.code)).toEqual(['not_billing_owner'])
	})

	it('blocks the owner while a plan is live, naming the workspace', () => {
		const preview = workspaceDeletionPreview(
			ME,
			'human',
			facts({ billing: { stripe_subscription_id: 'sub_1', status: 'active' } }),
		)
		expect(preview.blockers).toEqual([
			{ code: 'cancel_plan', message: expect.stringContaining('Acme') },
		])
	})

	it('allows deletion once the plan is cancelled', () => {
		const preview = workspaceDeletionPreview(
			ME,
			'human',
			facts({ billing: { stripe_subscription_id: 'sub_1', status: 'canceled' } }),
		)
		expect(preview.can_delete).toBe(true)
	})
})
