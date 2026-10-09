import { NO_CREDITS_PILL, shouldShowNoCreditsPill } from '@/components/loops/loop-pill'
import { describe, expect, it } from 'vitest'

describe('NO_CREDITS_PILL tokens', () => {
	it('carries the verbatim SPEC copy for both viewports and screen readers', () => {
		expect(NO_CREDITS_PILL.label).toBe('NO CREDITS')
		expect(NO_CREDITS_PILL.mobileLabel).toBe('NO CR.')
		expect(NO_CREDITS_PILL.ariaLabel).toBe('Paused — no credits')
		expect(NO_CREDITS_PILL.tooltip).toBe('Paused — the credit balance is empty. Top up in Billing.')
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
