import { describe, expect, it } from 'vitest'
import { buildPlanLimitEmail, firstNameOf } from '../../services/plan-limit-email'

const PERIOD_END = Date.UTC(2026, 11, 3)
const base = {
	firstName: 'Anna',
	workspaceName: 'Acme',
	periodEnd: PERIOD_END,
	planUrl: 'https://app.test/ws-1/settings/billing?surface=email&block=plan_limit',
}

describe('buildPlanLimitEmail', () => {
	it('words a paid plan with the plan name and the renewal date', () => {
		const mail = buildPlanLimitEmail({ ...base, plan: 'pro' })

		expect(mail.subject).toBe('Your Maskin plan is used up for this month')
		expect(mail.text).toContain('Hey Anna,')
		expect(mail.text).toContain('Acme has used 100% of its Pro plan.')
		expect(mail.text).toContain('New work waits until your plan renews on 3 December 2026.')
		expect(mail.text).toContain(
			`If you want to keep going before then, you can change plan (${base.planUrl}).`,
		)
		expect(mail.html).toContain('Acme')
	})

	it('words the trial without a plan name or a date', () => {
		const mail = buildPlanLimitEmail({ ...base, plan: 'trial' })

		expect(mail.subject).toBe('Your Maskin trial usage is used up')
		expect(mail.text).toContain(
			'Acme has used all of the usage that comes with the free trial, so new work is paused. Everything you have built is still there.',
		)
		expect(mail.text).toContain(
			`To keep going, pick a plan (${base.planUrl}). Work starts again as soon as you do.`,
		)
		expect(mail.text).not.toContain('renews')
		expect(mail.text).not.toContain('100%')
	})

	it('makes the plan words the link inside the sentence, with no separate button', () => {
		const paid = buildPlanLimitEmail({ ...base, plan: 'pro' })
		const trial = buildPlanLimitEmail({ ...base, plan: 'trial' })
		const href = `href="${base.planUrl.replace(/&/g, '&amp;')}"`

		expect(paid.html).toMatch(/you can <a [^>]*>change plan<\/a>\./)
		expect(trial.html).toMatch(/To keep going, <a [^>]*>pick a plan<\/a>\. Work starts again/)
		for (const { html, text } of [paid, trial]) {
			expect(html.split(href)).toHaveLength(2)
			expect(html).not.toContain('Change plan')
			expect(html).not.toContain('Choose a plan')
			expect(text).not.toContain('Change plan')
			expect(text).not.toContain('Choose a plan')
		}
	})

	it('signs off both versions with Best, then Maskin', () => {
		for (const plan of ['trial', 'pro']) {
			const { text, html } = buildPlanLimitEmail({ ...base, plan })

			expect(text.endsWith('\n\nBest,\nMaskin')).toBe(true)
			expect(text).not.toContain('Cheers')
			expect(html).toContain('Best,')
			expect(html).not.toContain('Cheers')
		}
	})

	it('keeps to the pricing rules: no token count, no top-up offer, no price', () => {
		for (const plan of ['trial', 'starter', 'pro', 'team', 'ultra']) {
			const { subject, text, html } = buildPlanLimitEmail({ ...base, plan })
			const all = `${subject}\n${text}\n${html}`.toLowerCase()
			expect(all).not.toMatch(/token|top-up|top up|kr\b|dkk|\$/)
		}
	})

	it('has no stop link, because it is a mail about the account itself', () => {
		const { html } = buildPlanLimitEmail({ ...base, plan: 'pro' })

		expect(html).not.toContain('Stop these emails')
	})

	it('escapes the workspace name in the HTML', () => {
		const { html } = buildPlanLimitEmail({ ...base, plan: 'pro', workspaceName: '<b>Acme</b>' })

		expect(html).not.toContain('<b>Acme</b>')
		expect(html).toContain('&lt;b&gt;Acme&lt;/b&gt;')
	})
})

describe('firstNameOf', () => {
	it('takes the first word and falls back to there', () => {
		expect(firstNameOf('Anna Berg')).toBe('Anna')
		expect(firstNameOf('  ')).toBe('there')
		expect(firstNameOf(null)).toBe('there')
	})
})
