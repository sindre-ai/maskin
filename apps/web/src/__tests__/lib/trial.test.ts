import { trialCardState } from '@/lib/trial'
import { describe, expect, it } from 'vitest'

const DAY = 24 * 60 * 60 * 1000

describe('trialCardState', () => {
	it('counts whole days left, rounding up', () => {
		expect(trialCardState({ plan: 'trial', period_resets_in_ms: 4.2 * DAY })).toEqual({
			title: 'Trial ends in 5 days',
		})
	})

	it('says 1 day when exactly one day is left', () => {
		expect(trialCardState({ plan: 'trial', period_resets_in_ms: DAY })).toEqual({
			title: 'Trial ends in 1 day',
		})
	})

	it('says today inside the last day', () => {
		expect(trialCardState({ plan: 'trial', period_resets_in_ms: DAY / 2 })).toEqual({
			title: 'Trial ends today',
		})
	})

	it('shows nothing once the trial has ended', () => {
		expect(trialCardState({ plan: 'trial', period_resets_in_ms: 0 })).toBeNull()
	})

	it('shows nothing on a paid plan', () => {
		expect(trialCardState({ plan: 'pro', period_resets_in_ms: 10 * DAY })).toBeNull()
	})

	it('shows nothing while usage is unknown or has no end', () => {
		expect(trialCardState(undefined)).toBeNull()
		expect(trialCardState({ plan: 'trial', period_resets_in_ms: null })).toBeNull()
	})
})
