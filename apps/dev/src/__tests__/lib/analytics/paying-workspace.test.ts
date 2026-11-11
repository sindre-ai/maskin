import { describe, expect, it } from 'vitest'
import { isPayingWorkspace } from '../../../lib/analytics/paying-workspace'

const billing = (over: Record<string, unknown>) => ({
	billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_1', ...over },
})

describe('isPayingWorkspace', () => {
	it('is true for an active pro or team subscription', () => {
		expect(isPayingWorkspace(billing({}))).toBe(true)
		expect(isPayingWorkspace(billing({ plan: 'team' }))).toBe(true)
	})

	it('is true for a late payment that has not been canceled', () => {
		expect(isPayingWorkspace(billing({ status: 'past_due' }))).toBe(true)
	})

	it('is false on a trial, a canceled plan or a checkout that never finished', () => {
		expect(isPayingWorkspace(billing({ plan: 'trial' }))).toBe(false)
		expect(isPayingWorkspace(billing({ status: 'canceled' }))).toBe(false)
		expect(isPayingWorkspace(billing({ status: 'incomplete' }))).toBe(false)
	})

	it('is false for the enterprise BYO plan and for a plan with no subscription', () => {
		expect(isPayingWorkspace(billing({ plan: 'enterprise' }))).toBe(false)
		expect(isPayingWorkspace(billing({ stripe_subscription_id: null }))).toBe(false)
		expect(isPayingWorkspace(billing({ stripe_subscription_id: '' }))).toBe(false)
	})

	it('is false for settings that cannot be read', () => {
		expect(isPayingWorkspace(null)).toBe(false)
		expect(isPayingWorkspace('x')).toBe(false)
		expect(isPayingWorkspace({})).toBe(false)
		expect(isPayingWorkspace({ billing: 'pro' })).toBe(false)
	})
})
