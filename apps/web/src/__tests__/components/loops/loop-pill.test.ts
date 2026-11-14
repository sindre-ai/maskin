import { UPGRADE_PILL, shouldShowNoCreditsPill } from '@/components/loops/loop-pill'
import { describe, expect, it } from 'vitest'

describe('UPGRADE_PILL tokens', () => {
	it('says Upgrade on both viewports, like the left-nav trial card', () => {
		expect(UPGRADE_PILL.label).toBe('Upgrade')
		expect(UPGRADE_PILL.mobileLabel).toBe('Upgrade')
		expect(UPGRADE_PILL.ariaLabel).toBe('Paused. Upgrade your plan.')
		expect(UPGRADE_PILL.tooltip).toBe('Paused. Upgrade your plan in Billing.')
	})

	it('has no top-up, credit or NO CREDITS wording', () => {
		const all = Object.values(UPGRADE_PILL).join(' ')
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
