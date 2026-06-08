import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
	billingAfterByoTransition,
	cancelActivePaidSubscription,
	cancelPaidPlanAndDowngrade,
	hasActivePaidPlan,
	patchAddsByoSource,
	settingsAfterPaidPlanActivation,
} from '../../lib/llm-source-mutex'
import { createTestContext } from '../setup'

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

	it('returns true only for fully active Stripe subs (not past_due / incomplete)', () => {
		// Narrowed deliberately so a BYO write during SCA (incomplete) doesn't
		// strand the user, and so the webhook + PATCH/OAuth sides read the
		// same single criterion when deciding to clear the other slot.
		expect(
			hasActivePaidPlan({
				billing: { plan: 'starter', status: 'active', stripe_subscription_id: 'sub_a' },
			}),
		).toBe(true)
		expect(
			hasActivePaidPlan({
				billing: { plan: 'pro', status: 'past_due', stripe_subscription_id: 'sub_b' },
			}),
		).toBe(false)
		expect(
			hasActivePaidPlan({
				billing: { plan: 'pro', status: 'incomplete', stripe_subscription_id: 'sub_c' },
			}),
		).toBe(false)
	})

	it('narrows the input so callers can read stripe_subscription_id without a non-null assertion', () => {
		const settings = {
			billing: {
				plan: 'pro' as const,
				status: 'active' as const,
				stripe_subscription_id: 'sub_z',
			},
		}
		if (hasActivePaidPlan(settings)) {
			// Type predicate: TypeScript narrows .billing.stripe_subscription_id
			// to `string`, no `!` required. Read it here so the compiler enforces
			// the narrowing — a regression would fail tsc.
			expect(settings.billing.stripe_subscription_id.startsWith('sub_')).toBe(true)
		} else {
			throw new Error('expected hasActivePaidPlan to narrow')
		}
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

describe('cancelPaidPlanAndDowngrade', () => {
	const wsId = '11111111-1111-1111-1111-111111111111'

	function makeStripeFactory() {
		const cancel = vi.fn().mockResolvedValue({})
		const client = { subscriptions: { cancel } } as unknown as Stripe
		return { cancel, getStripe: () => client }
	}

	it('cancels Stripe inside the same transaction, then writes settings in one UPDATE', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							stripe_subscription_id: 'sub_x',
						},
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: { llm_keys: { anthropic: 'k' } } }]
		const { cancel, getStripe } = makeStripeFactory()

		const result = await cancelPaidPlanAndDowngrade({
			db,
			workspaceId: wsId,
			getStripe,
			flow: 'BYOLLM transition',
			buildNextSettings: (locked, downgradedBilling) => ({
				...locked,
				llm_keys: { anthropic: 'k' },
				...(downgradedBilling ? { billing: downgradedBilling } : {}),
			}),
		})

		expect(result.ok).toBe(true)
		expect(cancel).toHaveBeenCalledWith('sub_x')
		expect(calls.updates).toHaveLength(1)
	})

	it('returns 404 without calling Stripe when the workspace row is missing', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [[]]
		const { cancel, getStripe } = makeStripeFactory()

		const result = await cancelPaidPlanAndDowngrade({
			db,
			workspaceId: wsId,
			getStripe,
			flow: 'BYOLLM transition',
			buildNextSettings: () => ({}),
		})

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(404)
		expect(cancel).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(0)
	})

	it('returns 500 and does NOT write when Stripe cancel throws a non-missing error', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_x' },
					},
				},
			],
		]
		const cancel = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error('rate_limited'), { code: 'rate_limit' }))
		const client = { subscriptions: { cancel } } as unknown as Stripe

		const result = await cancelPaidPlanAndDowngrade({
			db,
			workspaceId: wsId,
			getStripe: () => client,
			flow: 'BYOLLM transition',
			buildNextSettings: () => ({}),
		})

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(500)
		expect(calls.updates).toHaveLength(0)
	})

	it('skips Stripe and writes settings unchanged-billing when the locked row has no active paid plan', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: { plan: 'pro', status: 'incomplete', stripe_subscription_id: 'sub_sca' },
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]
		const { cancel, getStripe } = makeStripeFactory()

		await cancelPaidPlanAndDowngrade({
			db,
			workspaceId: wsId,
			getStripe,
			flow: 'BYOLLM transition',
			buildNextSettings: (locked, downgradedBilling) => {
				// downgradedBilling should be undefined when no active paid plan
				expect(downgradedBilling).toBeUndefined()
				return { ...locked, llm_keys: { anthropic: 'k' } }
			},
		})

		expect(cancel).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(1)
	})

	it('returns 500 with a clear message when Stripe is not configured but a paid plan exists', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_x' },
					},
				},
			],
		]

		const result = await cancelPaidPlanAndDowngrade({
			db,
			workspaceId: wsId,
			getStripe: () => {
				throw new Error('STRIPE_SECRET_KEY missing')
			},
			flow: 'BYOLLM transition',
			buildNextSettings: () => ({}),
		})

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.status).toBe(500)
			expect(result.error.error.message).toBe('Stripe is not configured')
		}
		expect(calls.updates).toHaveLength(0)
	})
})

describe('patchAddsByoSource', () => {
	it('triggers when llm_keys.anthropic is being set to a string', () => {
		expect(patchAddsByoSource({ llm_keys: { anthropic: 'sk-x' } })).toBe(true)
	})

	it('does not trigger when llm_keys.anthropic is being cleared (null)', () => {
		expect(patchAddsByoSource({ llm_keys: { anthropic: null } })).toBe(false)
	})

	it('does not trigger for empty or whitespace-only anthropic keys', () => {
		// The schema layer rejects these with a 400 first; this is defense in
		// depth so a direct caller can't drag the mutex through a cancel for a
		// key that stores nothing usable.
		expect(patchAddsByoSource({ llm_keys: { anthropic: '' } })).toBe(false)
		expect(patchAddsByoSource({ llm_keys: { anthropic: '   ' } })).toBe(false)
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
