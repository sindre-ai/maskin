import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
	billingAfterByoTransition,
	cancelActivePaidSubscription,
	hasActivePaidPlan,
	patchAddsByoSource,
	settingsAfterPaidPlanActivation,
} from '../../lib/llm-source-mutex'

describe('hasActivePaidPlan', () => {
	it('returns false when settings has no billing block', () => {
		expect(hasActivePaidPlan({ billing: undefined })).toBe(false)
	})

	it('returns false when billing exists without a stripe_subscription_id', () => {
		expect(
			hasActivePaidPlan({
				billing: { plan: 'trial', status: 'incomplete' },
			}),
		).toBe(false)
	})

	it('returns false when status is canceled', () => {
		expect(
			hasActivePaidPlan({
				billing: { plan: 'byollm', status: 'canceled', stripe_subscription_id: 'sub_x' },
			}),
		).toBe(false)
	})

	it('returns true for active and past_due Stripe subs', () => {
		expect(
			hasActivePaidPlan({
				billing: { plan: 'starter', status: 'active', stripe_subscription_id: 'sub_a' },
			}),
		).toBe(true)
		expect(
			hasActivePaidPlan({
				billing: { plan: 'pro', status: 'past_due', stripe_subscription_id: 'sub_b' },
			}),
		).toBe(true)
	})
})

describe('cancelActivePaidSubscription', () => {
	it('calls stripe.subscriptions.cancel with the subscription id', async () => {
		const cancel = vi.fn().mockResolvedValue({})
		const stripe = { subscriptions: { cancel } } as unknown as Stripe
		await cancelActivePaidSubscription(stripe, 'sub_z')
		expect(cancel).toHaveBeenCalledWith('sub_z')
	})

	it('swallows resource_missing errors so a stale Stripe state cannot block the transition', async () => {
		const err = Object.assign(new Error('No such subscription'), { code: 'resource_missing' })
		const cancel = vi.fn().mockRejectedValue(err)
		const stripe = { subscriptions: { cancel } } as unknown as Stripe
		await expect(cancelActivePaidSubscription(stripe, 'sub_gone')).resolves.toBeUndefined()
	})

	it('propagates other Stripe errors so the caller can surface 5xx', async () => {
		const err = Object.assign(new Error('rate_limited'), {
			code: 'rate_limit',
			type: 'StripeRateLimitError',
		})
		const cancel = vi.fn().mockRejectedValue(err)
		const stripe = { subscriptions: { cancel } } as unknown as Stripe
		await expect(cancelActivePaidSubscription(stripe, 'sub_a')).rejects.toThrow('rate_limited')
	})
})

describe('billingAfterByoTransition', () => {
	it('returns undefined when there was no billing block to start with', () => {
		expect(billingAfterByoTransition(undefined)).toBeUndefined()
	})

	it('leaves an already-canceled, subscription-less block untouched', () => {
		const current = { plan: 'byollm' as const, status: 'canceled' as const }
		expect(billingAfterByoTransition(current)).toEqual(current)
	})

	it('rolls plan to byollm, status to canceled, and drops the subscription id', () => {
		const current = {
			plan: 'pro' as const,
			status: 'active' as const,
			stripe_subscription_id: 'sub_99',
			stripe_customer_id: 'cus_99',
			hard_cap_tokens: 96_000_000,
		}
		expect(billingAfterByoTransition(current)).toEqual({
			plan: 'byollm',
			status: 'canceled',
			stripe_subscription_id: null,
			stripe_customer_id: 'cus_99',
			hard_cap_tokens: 96_000_000,
		})
	})
})

describe('settingsAfterPaidPlanActivation', () => {
	it('drops claude_oauth, custom_llm, and llm_keys.anthropic', () => {
		const input = {
			display_names: { insight: 'Signal' },
			custom_llm: { enabled: true, api_key: 'sk-byo' },
			claude_oauth: { encryptedAccessToken: 'enc' },
			llm_keys: { anthropic: 'sk-ant', openai: 'sk-open' },
		}
		const out = settingsAfterPaidPlanActivation(input)
		expect(out).toEqual({
			display_names: { insight: 'Signal' },
			llm_keys: { openai: 'sk-open' },
		})
	})

	it('does not mutate the input', () => {
		const input = { custom_llm: { enabled: true }, llm_keys: { anthropic: 'sk' } }
		settingsAfterPaidPlanActivation(input)
		expect(input).toEqual({ custom_llm: { enabled: true }, llm_keys: { anthropic: 'sk' } })
	})

	it('handles a settings object that has no BYO slots at all', () => {
		const input = { display_names: { bet: 'Wager' } }
		expect(settingsAfterPaidPlanActivation(input)).toEqual({ display_names: { bet: 'Wager' } })
	})
})

describe('patchAddsByoSource', () => {
	it('triggers when llm_keys.anthropic is being set to a string', () => {
		expect(patchAddsByoSource({ llm_keys: { anthropic: 'sk-x' } })).toBe(true)
	})

	it('does not trigger when llm_keys.anthropic is being cleared (null)', () => {
		expect(patchAddsByoSource({ llm_keys: { anthropic: null } })).toBe(false)
	})

	it('triggers when custom_llm is enabled with an api_key', () => {
		expect(
			patchAddsByoSource({
				custom_llm: { enabled: true, api_key: 'k', base_url: 'http://x', model: 'm' },
			}),
		).toBe(true)
	})

	it('does not trigger when custom_llm is being disabled', () => {
		expect(patchAddsByoSource({ custom_llm: { enabled: false } })).toBe(false)
	})

	it('does not trigger for unrelated settings changes', () => {
		expect(patchAddsByoSource({ display_names: { insight: 'Signal' } })).toBe(false)
		expect(patchAddsByoSource({})).toBe(false)
	})
})
