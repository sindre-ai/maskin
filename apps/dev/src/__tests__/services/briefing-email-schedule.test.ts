import { describe, expect, it } from 'vitest'
import { dueEmailStep, lookbackDays } from '../../services/briefing-email-scheduler'

const row = (over: Partial<Parameters<typeof dueEmailStep>[0]> = {}) => ({
	emailDigestEnabled: true as boolean | null,
	emailOnboardingStep: 0,
	emailLastSentOn: null as string | null,
	emailRhythm: null as string | null,
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

describe('dueEmailStep: weekly', () => {
	const weekly = (over: Partial<Parameters<typeof dueEmailStep>[0]> = {}) =>
		row({ emailRhythm: 'weekly', ...over })

	it('mails a weekly person only when the last send is 6 or more days back', () => {
		const sent = weekly({ emailOnboardingStep: 3, emailLastSentOn: '2026-11-15' })
		expect(dueEmailStep(sent, '2026-11-16', 20)).toBeNull()
		expect(dueEmailStep(sent, '2026-11-20', 20)).toBeNull() // 5 days
		expect(dueEmailStep(sent, '2026-11-21', 20)).toEqual({ step: 'daily', nextCounter: 3 }) // 6 days
		expect(dueEmailStep(sent, '2026-11-30', 20)).toEqual({ step: 'daily', nextCounter: 3 })
	})

	it('a person with an empty or daily rhythm is still mailed the next day', () => {
		const sent = { emailOnboardingStep: 3, emailLastSentOn: '2026-11-15' }
		expect(dueEmailStep(row({ ...sent, emailRhythm: null }), '2026-11-16', 20)).toEqual({
			step: 'daily',
			nextCounter: 3,
		})
		expect(dueEmailStep(row({ ...sent, emailRhythm: 'daily' }), '2026-11-16', 20)).toEqual({
			step: 'daily',
			nextCounter: 3,
		})
	})

	it('keeps the teaching steps in order, with the age wait and the step gaps on top of the week', () => {
		// Nothing sent yet: the first mail is not held back by the week, only by the age wait.
		expect(dueEmailStep(weekly(), '2026-11-08', 0)).toBeNull()
		expect(dueEmailStep(weekly(), '2026-11-09', 1)).toEqual({ step: 1, nextCounter: 1 })
		const one = weekly({ emailOnboardingStep: 1, emailLastSentOn: '2026-11-09' })
		expect(dueEmailStep(one, '2026-11-14', 6)).toBeNull() // 5 days: the week is not up
		expect(dueEmailStep(one, '2026-11-15', 7)).toEqual({ step: 2, nextCounter: 2 })
		// A young account: the day 7 wait for step 3 holds even when the week is up.
		const two = weekly({ emailOnboardingStep: 2, emailLastSentOn: '2026-11-09' })
		expect(dueEmailStep(two, '2026-11-15', 6)).toBeNull()
		expect(dueEmailStep(two, '2026-11-15', 7)).toEqual({ step: 3, nextCounter: 3 })
	})

	it('never mails twice on one day', () => {
		expect(
			dueEmailStep(
				weekly({ emailOnboardingStep: 3, emailLastSentOn: '2026-11-15' }),
				'2026-11-15',
				20,
			),
		).toBeNull()
	})
})

describe('lookbackDays', () => {
	it('looks back since the last mail, at least a day and at most a week', () => {
		expect(lookbackDays(null, '2026-11-15', '2026-11-16')).toBe(1)
		expect(lookbackDays('daily', '2026-11-15', '2026-11-18')).toBe(3)
		expect(lookbackDays('daily', '2026-10-01', '2026-11-18')).toBe(7)
		expect(lookbackDays('weekly', '2026-11-15', '2026-11-21')).toBe(6)
		expect(lookbackDays('weekly', '2026-11-15', '2026-11-30')).toBe(7)
	})

	it('the first mail looks back a day, or the whole week for a weekly person', () => {
		expect(lookbackDays(null, null, '2026-11-16')).toBe(1)
		expect(lookbackDays('daily', null, '2026-11-16')).toBe(1)
		expect(lookbackDays('weekly', null, '2026-11-16')).toBe(7)
	})
})
