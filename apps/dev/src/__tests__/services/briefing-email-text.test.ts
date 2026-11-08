import { describe, expect, it } from 'vitest'
import { buildSummaryEmail } from '../../services/briefing-email-text'
import type { BriefingText } from '../../services/briefing-push-scheduler'

const summary = (over: Partial<BriefingText> = {}): BriefingText => ({
	workspaceId: 'w1',
	title: '2 things need you',
	body: "Ada finished 'Draft the launch note'",
	waiting: 2,
	finished: 1,
	topObjectId: 'o1',
	...over,
})

const urls = {
	buttonUrl: 'https://maskin.io/w1/objects/o1?surface=email',
	stopUrl: 'https://maskin.io/email/stop?token=abc',
}

describe('buildSummaryEmail', () => {
	it('uses the push title as subject and has text, html, one button and the stop link', () => {
		const mail = buildSummaryEmail({ summary: summary(), step: 'weekly', ...urls })
		expect(mail.subject).toBe('2 things need you')
		expect(mail.text).toContain("Ada finished 'Draft the launch note'")
		expect(mail.text).toContain(urls.buttonUrl)
		expect(mail.text).toContain(urls.stopUrl)
		expect(mail.html).toContain(`href="${urls.buttonUrl}"`)
		expect(mail.html).toContain(`href="${urls.stopUrl}"`)
		expect(mail.html.match(/display: inline-block/g)).toHaveLength(1)
	})

	it('sets the one-click unsubscribe headers to the stop link', () => {
		const mail = buildSummaryEmail({ summary: summary(), step: 1, ...urls })
		expect(mail.headers).toEqual({
			'List-Unsubscribe': `<${urls.stopUrl}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		})
	})

	it('adds a one-line how-to on steps 1 to 3 and none on the weekly mail', () => {
		const intro = (step: 1 | 2 | 3 | 'weekly') =>
			buildSummaryEmail({ summary: summary(), step, ...urls }).text.split('\n')
		expect(intro(1)).toContain(
			'Your agents work in the background. When one needs you, it shows up on your For You screen.',
		)
		expect(intro(2).join('\n')).toContain('A card is one thing waiting on you.')
		expect(intro(3).join('\n')).toContain('A loop is a routine')
		const weekly = intro('weekly').join('\n')
		expect(weekly).not.toContain('A card is')
		expect(weekly).not.toContain('A loop is')
		expect(weekly).not.toContain('Your agents work')
	})

	it('labels the button by what waits', () => {
		const waiting = buildSummaryEmail({ summary: summary(), step: 'weekly', ...urls })
		expect(waiting.html).toContain('>Open it</a>')
		const finishedOnly = buildSummaryEmail({
			summary: summary({ waiting: 0, topObjectId: null }),
			step: 'weekly',
			...urls,
		})
		expect(finishedOnly.html).toContain('>Open Maskin</a>')
	})

	it('escapes text that came from a card headline', () => {
		const mail = buildSummaryEmail({
			summary: summary({ body: '<script>alert(1)</script> & more' }),
			step: 'weekly',
			...urls,
		})
		expect(mail.html).not.toContain('<script>')
		expect(mail.html).toContain('&lt;script&gt;')
		expect(mail.html).toContain('&amp; more')
	})
})
