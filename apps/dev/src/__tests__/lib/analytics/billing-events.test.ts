import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

import {
	type BillingSnapshot,
	classifyBillingEmission,
	emitBillingEvent,
	mrrUsdForPlan,
} from '../../../lib/analytics/billing-events'
import { capturePosthogEvent } from '../../../lib/analytics/posthog'

const captureMock = vi.mocked(capturePosthogEvent)

const snapshot = (
	partial: Partial<BillingSnapshot> & Pick<BillingSnapshot, 'plan'>,
): BillingSnapshot => ({
	status: 'incomplete',
	stripe_subscription_id: null,
	...partial,
})

beforeEach(() => {
	captureMock.mockClear()
})

afterEach(() => {
	captureMock.mockReset()
	captureMock.mockResolvedValue(undefined)
})

describe('mrrUsdForPlan', () => {
	it('returns 20 for starter and 60 for pro', () => {
		expect(mrrUsdForPlan('starter')).toBe(20)
		expect(mrrUsdForPlan('pro')).toBe(60)
	})
})

describe('classifyBillingEmission', () => {
	it('emits subscription_started on incomplete -> active transition for a paid plan', () => {
		const decision = classifyBillingEmission(
			'customer.subscription.created',
			snapshot({ plan: 'trial', status: 'incomplete', stripe_subscription_id: null }),
			snapshot({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_1' }),
		)
		expect(decision).toEqual({
			event: 'subscription_started',
			plan: 'starter',
			stripeSubscriptionId: 'sub_1',
		})
	})

	it('does NOT re-emit subscription_started when prev is already active', () => {
		const decision = classifyBillingEmission(
			'customer.subscription.updated',
			snapshot({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_1' }),
			snapshot({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_1' }),
		)
		expect(decision).toBeNull()
	})

	it('emits subscription_past_due on active -> past_due', () => {
		const decision = classifyBillingEmission(
			'customer.subscription.updated',
			snapshot({ plan: 'pro', status: 'active', stripe_subscription_id: 'sub_x' }),
			snapshot({ plan: 'pro', status: 'past_due', stripe_subscription_id: 'sub_x' }),
		)
		expect(decision).toEqual({
			event: 'subscription_past_due',
			plan: 'pro',
			stripeSubscriptionId: 'sub_x',
		})
	})

	it('emits subscription_canceled on customer.subscription.deleted using prev plan', () => {
		// The webhook flips next.plan to 'byollm' before we classify, so the
		// only place the paid plan still lives is in the prev snapshot.
		const decision = classifyBillingEmission(
			'customer.subscription.deleted',
			snapshot({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_z' }),
			snapshot({ plan: 'byollm', status: 'canceled', stripe_subscription_id: null }),
		)
		expect(decision).toEqual({
			event: 'subscription_canceled',
			plan: 'starter',
			stripeSubscriptionId: 'sub_z',
		})
	})

	it('does NOT emit anything when no paid plan is involved', () => {
		const decision = classifyBillingEmission(
			'customer.subscription.updated',
			snapshot({ plan: 'trial', status: 'incomplete' }),
			snapshot({ plan: 'trial', status: 'active' }),
		)
		expect(decision).toBeNull()
	})

	it('does NOT emit subscription_started without a subscription id', () => {
		const decision = classifyBillingEmission(
			'customer.subscription.created',
			snapshot({ plan: 'trial' }),
			snapshot({ plan: 'pro', status: 'active', stripe_subscription_id: null }),
		)
		expect(decision).toBeNull()
	})

	it('does NOT emit on unrelated transitions', () => {
		const decision = classifyBillingEmission(
			'invoice.paid',
			snapshot({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_q' }),
			snapshot({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_q' }),
		)
		expect(decision).toBeNull()
	})
})

describe('emitBillingEvent', () => {
	it('calls capturePosthogEvent with the brief-mandated property names', async () => {
		await emitBillingEvent('ws-1', {
			event: 'subscription_started',
			plan: 'pro',
			stripeSubscriptionId: 'sub_42',
		})
		expect(captureMock).toHaveBeenCalledWith(
			'subscription_started',
			'ws-1',
			{
				workspace_id: 'ws-1',
				plan: 'pro',
				mrr_usd: 60,
				stripe_subscription_id: 'sub_42',
			},
			{},
		)
	})

	it('forwards the timestamp option for backfill', async () => {
		const ts = new Date('2026-06-22T12:00:00.000Z')
		await emitBillingEvent(
			'ws-2',
			{
				event: 'subscription_canceled',
				plan: 'starter',
				stripeSubscriptionId: 'sub_99',
			},
			{ timestamp: ts },
		)
		expect(captureMock).toHaveBeenCalledWith(
			'subscription_canceled',
			'ws-2',
			expect.objectContaining({ workspace_id: 'ws-2', plan: 'starter', mrr_usd: 20 }),
			{ timestamp: ts },
		)
	})
})
