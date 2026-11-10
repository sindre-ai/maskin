import {
	NO_CREDITS_PILL,
	PLAN_USED_UP_PILL,
	shouldShowNoCreditsPill,
} from '@/components/loops/loop-pill'
import { describe, expect, it } from 'vitest'

describe('NO_CREDITS_PILL tokens', () => {
	it('carries the verbatim SPEC copy for both viewports and screen readers', () => {
		expect(NO_CREDITS_PILL.label).toBe('NO CREDITS')
		expect(NO_CREDITS_PILL.mobileLabel).toBe('NO CR.')
		expect(NO_CREDITS_PILL.ariaLabel).toBe('Paused — no credits')
		expect(NO_CREDITS_PILL.tooltip).toBe('Paused — the credit balance is empty. Top up in Billing.')
	})
})

describe('PLAN_USED_UP_PILL tokens', () => {
	it('says the plan is used up, with no top-up or credit wording', () => {
		expect(PLAN_USED_UP_PILL.label).toBe('Plan used up')
		expect(PLAN_USED_UP_PILL.mobileLabel).toBe('Used up')
		const all = Object.values(PLAN_USED_UP_PILL).join(' ')
		expect(all).not.toMatch(/top up|credit/i)
	})
})

describe('shouldShowNoCreditsPill', () => {
	it('is true only when the loop is paused AND the workspace credit balance is empty', () => {
		expect(shouldShowNoCreditsPill('paused', 0)).toBe(true)
		expect(shouldShowNoCreditsPill('paused', -50)).toBe(true)
	})

	it('is false when the loop is paused but the workspace still has credits', () => {
		expect(shouldShowNoCreditsPill('paused', 1)).toBe(false)
		expect(shouldShowNoCreditsPill('paused', 5_000)).toBe(false)
	})

	it('is false on non-paused rows even at zero credits — parity with SPEC states table', () => {
		expect(shouldShowNoCreditsPill('learning', 0)).toBe(false)
		expect(shouldShowNoCreditsPill('supervised', 0)).toBe(false)
		expect(shouldShowNoCreditsPill('fully_autonomous', 0)).toBe(false)
		expect(shouldShowNoCreditsPill('waiting_on_you', 0)).toBe(false)
		expect(shouldShowNoCreditsPill('draft', 0)).toBe(false)
	})

	it('is false when the credit balance is unknown (loading / errored billing fetch)', () => {
		expect(shouldShowNoCreditsPill('paused', null)).toBe(false)
		expect(shouldShowNoCreditsPill('paused', undefined)).toBe(false)
	})
})
