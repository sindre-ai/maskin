import { describe, expect, it } from 'vitest'
import { dueEmailStep } from '../../services/briefing-email-scheduler'

const row = (over: Partial<Parameters<typeof dueEmailStep>[0]> = {}) => ({
	emailDigestEnabled: true as boolean | null,
	emailOnboardingStep: 0,
	emailLastSentOn: null as string | null,
	...over,
})

describe('dueEmailStep', () => {
	it('sends nothing on sign-up day, step 1 from day 1', () => {
		expect(dueEmailStep(row(), '2026-11-08', 0)).toBeNull()
		expect(dueEmailStep(row(), '2026-11-09', 1)).toEqual({ step: 1, nextCounter: 1 })
	})

	it('sends step 2 from day 3 and step 3 from day 7', () => {
		expect(
			dueEmailStep(row({ emailOnboardingStep: 1, emailLastSentOn: '2026-11-09' }), '2026-11-10', 2),
		).toBeNull()
		expect(
			dueEmailStep(row({ emailOnboardingStep: 1, emailLastSentOn: '2026-11-09' }), '2026-11-11', 3),
		).toEqual({
			step: 2,
			nextCounter: 2,
		})
		expect(
			dueEmailStep(row({ emailOnboardingStep: 2, emailLastSentOn: '2026-11-11' }), '2026-11-14', 6),
		).toBeNull()
		expect(
			dueEmailStep(row({ emailOnboardingStep: 2, emailLastSentOn: '2026-11-11' }), '2026-11-15', 7),
		).toEqual({
			step: 3,
			nextCounter: 3,
		})
	})

	it('never skips a step for a late first tick and sends one a day at most', () => {
		expect(dueEmailStep(row(), '2026-12-25', 47)).toEqual({ step: 1, nextCounter: 1 })
		expect(
			dueEmailStep(
				row({ emailOnboardingStep: 1, emailLastSentOn: '2026-12-25' }),
				'2026-12-25',
				47,
			),
		).toBeNull()
		expect(
			dueEmailStep(
				row({ emailOnboardingStep: 1, emailLastSentOn: '2026-12-25' }),
				'2026-12-26',
				48,
			),
		).toEqual({
			step: 2,
			nextCounter: 2,
		})
	})

	it('goes weekly after step 3, counting 7 days from the last send', () => {
		const done = row({ emailOnboardingStep: 3, emailLastSentOn: '2026-11-15' })
		expect(dueEmailStep(done, '2026-11-21', 13)).toBeNull()
		expect(dueEmailStep(done, '2026-11-22', 14)).toEqual({ step: 'weekly', nextCounter: 3 })
	})

	it('starts an active member with no saved choice at the weekly summary', () => {
		expect(dueEmailStep(row({ emailDigestEnabled: null }), '2026-11-08', 400)).toEqual({
			step: 'weekly',
			nextCounter: 3,
		})
		expect(
			dueEmailStep(
				row({ emailDigestEnabled: null, emailLastSentOn: '2026-11-04' }),
				'2026-11-08',
				400,
			),
		).toBeNull()
	})
})
