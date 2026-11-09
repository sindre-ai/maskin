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
		const afterFirst = row({ emailOnboardingStep: 1, emailLastSentOn: '2026-12-25' })
		expect(dueEmailStep(afterFirst, '2026-12-25', 47)).toBeNull()
		// Step 2 keeps its spacing from the previous send, however old the account is.
		expect(dueEmailStep(afterFirst, '2026-12-26', 48)).toBeNull()
		expect(dueEmailStep(afterFirst, '2026-12-27', 49)).toEqual({ step: 2, nextCounter: 2 })
	})

	it('goes daily after step 3: one a day, no wait', () => {
		const done = row({ emailOnboardingStep: 3, emailLastSentOn: '2026-11-15' })
		expect(dueEmailStep(done, '2026-11-15', 13)).toBeNull()
		expect(dueEmailStep(done, '2026-11-16', 14)).toEqual({ step: 'daily', nextCounter: 3 })
		expect(dueEmailStep(done, '2026-11-22', 20)).toEqual({ step: 'daily', nextCounter: 3 })
	})

	it('starts an existing member with no saved choice at step 1, then the same spacing', () => {
		const existing = row({ emailDigestEnabled: null })
		expect(dueEmailStep(existing, '2026-11-08', 400)).toEqual({ step: 1, nextCounter: 1 })
		// Once claimed the row has email on and step 1: step 2 two days later, step 3 four after that.
		const afterFirst = row({ emailOnboardingStep: 1, emailLastSentOn: '2026-11-08' })
		expect(dueEmailStep(afterFirst, '2026-11-09', 401)).toBeNull()
		expect(dueEmailStep(afterFirst, '2026-11-10', 402)).toEqual({ step: 2, nextCounter: 2 })
		const afterSecond = row({ emailOnboardingStep: 2, emailLastSentOn: '2026-11-10' })
		expect(dueEmailStep(afterSecond, '2026-11-13', 405)).toBeNull()
		expect(dueEmailStep(afterSecond, '2026-11-14', 406)).toEqual({ step: 3, nextCounter: 3 })
		// Not twice on the same day.
		expect(
			dueEmailStep(
				row({ emailDigestEnabled: null, emailLastSentOn: '2026-11-08' }),
				'2026-11-08',
				400,
			),
		).toBeNull()
	})
})
