import { describe, expect, it } from 'vitest'
import { buildSummaryEmail, pickNextStep } from '../../services/briefing-email-text'
import type { BriefingText } from '../../services/briefing-push-scheduler'

const summary = (over: Partial<BriefingText> = {}): BriefingText => ({
	workspaceId: 'w1',
	title: '2 things need you',
	body: "Ada finished 'Draft the launch note'",
	waiting: 2,
	finished: 1,
	topObjectId: 'o1',
	workspaceName: 'Acme',
	topHeadline: 'Approve the launch email',
	finishedRuns: [{ agentName: 'Ada', objectTitle: 'Draft the launch note' }],
	waitingElsewhere: 0,
	multiWorkspace: false,
	...over,
})

const run = (n: number) => ({ agentName: 'Ada', objectTitle: `Task ${n}` })

const urls = {
	nextStep: null as string | null,
	buttonUrl: 'https://maskin.io/w1/objects/o1?surface=email',
	stopUrl: 'https://maskin.io/email/stop?token=abc',
}

describe('buildSummaryEmail', () => {
	it('uses the push title as subject and has text, html, one button and the stop link', () => {
		const mail = buildSummaryEmail({ summary: summary(), step: 'daily', ...urls })
		expect(mail.subject).toBe('2 things need you')
		expect(mail.text).toContain("Ada finished 'Draft the launch note'")
		expect(mail.text).toContain('Starting with: Approve the launch email')
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

	it('adds a teaching block on steps 1 to 3 and none on the daily mail', () => {
		const text = (step: 1 | 2 | 3 | 'daily') =>
			buildSummaryEmail({ summary: summary(), step, ...urls }).text
		expect(text(1)).toContain('A card is one thing waiting on you.')
		expect(text(2)).toContain('A loop is a routine')
		expect(text(3)).toContain('What you can do next')
		const daily = text('daily')
		expect(daily).not.toContain('A card is')
		expect(daily).not.toContain('A loop is')
		expect(daily).not.toContain('What you can do next')
	})

	it('has the three parts: done for you, waiting on you, next step', () => {
		const mail = buildSummaryEmail({
			summary: summary(),
			step: 'daily',
			...urls,
			nextStep: 'Open the card at the top first.',
		})
		const at = (needle: string) => mail.text.indexOf(needle)
		expect(at('Done for you')).toBeGreaterThan(-1)
		expect(at('Done for you')).toBeLessThan(at('Waiting on you'))
		expect(at('Waiting on you')).toBeLessThan(at('Next step'))
		expect(mail.text).toContain('- Open the card at the top first.')
		expect(mail.html).toContain('<li>Open the card at the top first.</li>')
	})

	it('lists up to 5 finished runs, then "and N more", and leaves out empty parts', () => {
		const runs = [1, 2, 3, 4, 5].map(run)
		const mail = buildSummaryEmail({
			summary: summary({ finished: 8, finishedRuns: runs, waiting: 0, topHeadline: null }),
			step: 'daily',
			...urls,
		})
		expect(mail.text).toContain("- Ada finished 'Task 1'")
		expect(mail.text).toContain("- Ada finished 'Task 5'")
		expect(mail.text).toContain('- and 3 more')
		expect(mail.text).not.toContain('Waiting on you')
		expect(mail.text).not.toContain('Next step')
	})

	it('names the workspace and the others when the person is in several', () => {
		const mail = buildSummaryEmail({
			summary: summary({ multiWorkspace: true, waitingElsewhere: 2 }),
			step: 'daily',
			...urls,
		})
		expect(mail.text).toContain('Waiting on you in Acme')
		expect(mail.text).toContain('2 more in other workspaces')
	})

	it('labels the button by what waits', () => {
		const waiting = buildSummaryEmail({ summary: summary(), step: 'daily', ...urls })
		expect(waiting.html).toContain('>Open it</a>')
		const finishedOnly = buildSummaryEmail({
			summary: summary({ waiting: 0, topObjectId: null }),
			step: 'daily',
			...urls,
		})
		expect(finishedOnly.html).toContain('>Open Maskin</a>')
	})

	it('escapes text that came from a card headline', () => {
		const mail = buildSummaryEmail({
			summary: summary({ topHeadline: '<script>alert(1)</script> & more' }),
			step: 'daily',
			...urls,
		})
		expect(mail.html).not.toContain('<script>')
		expect(mail.html).toContain('&lt;script&gt;')
		expect(mail.html).toContain('&amp; more')
	})
})

describe('pickNextStep', () => {
	it('picks a waiting card first, then a first loop, else nothing', () => {
		expect(pickNextStep({ waiting: 2, hasLoop: false })).toBe('Open the card at the top first.')
		expect(pickNextStep({ waiting: 1, hasLoop: true })).toBe('Open the card that needs you.')
		expect(pickNextStep({ waiting: 0, hasLoop: false })).toContain('Create your first loop')
		expect(pickNextStep({ waiting: 0, hasLoop: true })).toBeNull()
	})
})
