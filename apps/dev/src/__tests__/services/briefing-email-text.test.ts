import { describe, expect, it, vi } from 'vitest'
import {
	STEP_LESSON,
	buildSummaryEmail,
	emailRole,
	pickNextStep,
} from '../../services/briefing-email-text'
import type { NextStepFacts } from '../../services/briefing-email-text'
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

	it('gives steps 1, 2 and 3 their own lesson and the daily mail none', () => {
		const text = (step: 1 | 2 | 3 | 'daily') =>
			buildSummaryEmail({ summary: summary(), step, ...urls }).text
		const lessons = Object.values(STEP_LESSON)
		expect(new Set(lessons).size).toBe(3)
		expect(text(1)).toContain(STEP_LESSON[1])
		expect(text(2)).toContain(STEP_LESSON[2])
		expect(text(3)).toContain(STEP_LESSON[3])
		for (const step of [1, 2, 3] as const) {
			const others = lessons.filter((l) => l !== STEP_LESSON[step])
			for (const other of others) expect(text(step)).not.toContain(other)
		}
		const daily = text('daily')
		for (const lesson of lessons) expect(daily).not.toContain(lesson)
	})

	it('carries the same lesson in the html part', () => {
		const html = buildSummaryEmail({ summary: summary(), step: 2, ...urls }).html
		expect(html).toContain('A flow is a team of agents')
		expect(html).not.toContain('A card is something')
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

	it('groups finished runs by flow: name, number finished, latest title', () => {
		const mail = buildSummaryEmail({
			summary: summary({
				finished: 4,
				waiting: 0,
				topHeadline: null,
				finishedRuns: [],
				finishedFlows: [
					{ flowName: 'Weekly research', runs: 3, latestTitle: 'Competitor update' },
					{ flowName: 'Support', runs: 1, latestTitle: null },
				],
			}),
			step: 'daily',
			...urls,
		})
		expect(mail.text).toContain("- Weekly research: 3 runs finished, latest 'Competitor update'")
		expect(mail.text).toContain('- Support: 1 run finished')
		// Only that runs finished: no result or success wording, and no plain "N agent runs" line.
		expect(mail.text).not.toMatch(/succe|fail|result/i)
		expect(mail.text).not.toContain('agent run')
	})

	it('names up to 3 flows, then "and N more flows"', () => {
		const flows = [1, 2, 3, 4, 5].map((n) => ({
			flowName: `Flow ${n}`,
			runs: 1,
			latestTitle: null,
		}))
		const mail = buildSummaryEmail({
			summary: summary({ finished: 5, finishedRuns: [], finishedFlows: flows, waiting: 0 }),
			step: 'daily',
			...urls,
		})
		expect(mail.text).toContain('- Flow 3: 1 run finished')
		expect(mail.text).not.toContain('Flow 4')
		expect(mail.text).toContain('- and 2 more flows')
	})

	it('keeps runs that tie to no flow in the plain list, with their own "and N more"', () => {
		const mail = buildSummaryEmail({
			summary: summary({
				finished: 10,
				waiting: 0,
				finishedRuns: [1, 2, 3, 4, 5].map(run),
				finishedFlows: [{ flowName: 'Weekly research', runs: 3, latestTitle: 'Brief' }],
			}),
			step: 'daily',
			...urls,
		})
		expect(mail.text).toContain("- Weekly research: 3 runs finished, latest 'Brief'")
		expect(mail.text).toContain("- Ada finished 'Task 1'")
		// 10 finished, 3 in the flow, 5 listed: 2 more, not 5.
		expect(mail.text).toContain('- and 2 more')
		expect(mail.text.indexOf('Weekly research')).toBeLessThan(mail.text.indexOf('Task 1'))
	})

	it('says "N agent runs finished" only for runs that tie to no flow', () => {
		const mail = buildSummaryEmail({
			summary: summary({
				finished: 5,
				waiting: 0,
				finishedRuns: [],
				finishedFlows: [{ flowName: 'Weekly research', runs: 3, latestTitle: null }],
			}),
			step: 'daily',
			...urls,
		})
		expect(mail.text).toContain('- 2 agent runs finished')
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
	const OPEN_ONE = 'Open the card that needs you.'
	const OPEN_TOP = 'Open the card at the top first.'
	const CREATE_FLOW = 'Create your first flow, a routine your agents repeat for you.'
	const INVITE = 'Invite a teammate, so your agents can work for more than just you.'

	const rows: Array<[string, NextStepFacts, string | null]> = [
		[
			'owner/admin, one card waits',
			{ role: 'owner_admin', waiting: 1, hasFlow: false, onlyMember: true },
			OPEN_ONE,
		],
		[
			'owner/admin, many cards wait',
			{ role: 'owner_admin', waiting: 3, hasFlow: true, onlyMember: false },
			OPEN_TOP,
		],
		[
			'owner/admin, no flow, alone',
			{ role: 'owner_admin', waiting: 0, hasFlow: false, onlyMember: true },
			CREATE_FLOW,
		],
		[
			'owner/admin, no flow, not alone',
			{ role: 'owner_admin', waiting: 0, hasFlow: false, onlyMember: false },
			CREATE_FLOW,
		],
		[
			'owner/admin, has a flow, alone',
			{ role: 'owner_admin', waiting: 0, hasFlow: true, onlyMember: true },
			INVITE,
		],
		[
			'owner/admin, has a flow, not alone',
			{ role: 'owner_admin', waiting: 0, hasFlow: true, onlyMember: false },
			null,
		],
		[
			'member, one card waits',
			{ role: 'member', waiting: 1, hasFlow: false, onlyMember: true },
			OPEN_ONE,
		],
		[
			'member, many cards wait',
			{ role: 'member', waiting: 2, hasFlow: true, onlyMember: false },
			OPEN_TOP,
		],
		[
			'member, no flow, alone',
			{ role: 'member', waiting: 0, hasFlow: false, onlyMember: true },
			null,
		],
		[
			'member, has a flow, alone',
			{ role: 'member', waiting: 0, hasFlow: true, onlyMember: true },
			null,
		],
		[
			'member, has a flow, not alone',
			{ role: 'member', waiting: 0, hasFlow: true, onlyMember: false },
			null,
		],
	]

	it.each(rows)('%s', (_name, facts, expected) => {
		expect(pickNextStep(facts)).toBe(expected)
		expect(pickNextStep(facts)).toBe(expected) // same input, same text
	})

	it('makes no network call', () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('no network in pickNextStep'))
		for (const [, facts] of rows) pickNextStep(facts)
		expect(fetchSpy).not.toHaveBeenCalled()
		fetchSpy.mockRestore()
	})
})

describe('emailRole', () => {
	it('maps owner and admin to owner_admin and everything else to member', () => {
		expect(emailRole('owner')).toBe('owner_admin')
		expect(emailRole('admin')).toBe('owner_admin')
		expect(emailRole('member')).toBe('member')
		expect(emailRole(null)).toBe('member')
		expect(emailRole(undefined)).toBe('member')
	})
})
