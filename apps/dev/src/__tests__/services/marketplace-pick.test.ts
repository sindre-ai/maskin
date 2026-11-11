import { describe, expect, it } from 'vitest'
import { buildSummaryEmail } from '../../services/briefing-email-text'
import type { CatalogFlow } from '../../services/marketplace-pick'
import { choosePick, pickWeekOpen } from '../../services/marketplace-pick'

const flow = (id: string, name: string, useCase: string | null): CatalogFlow => ({
	id,
	name,
	slug: name.toLowerCase().replace(/\W+/g, '-'),
	description: `${name} description`,
	useCase,
})

const A = flow('a', 'Alpha Watch', 'Discovery')
const B = flow('b', 'Beta Watch', 'Discovery')
const C = flow('c', 'Gamma Sales', 'Sales')

describe('choosePick', () => {
	it('picks a flow in the same category as an installed one, with the reason', () => {
		const pick = choosePick({ installed: [A], catalog: [A, B, C], dismissed: [] })
		expect(pick?.flow.id).toBe('b')
		expect(pick?.why).toBe('you already use Alpha Watch, and this is another flow for Discovery.')
	})

	it('matches the category ignoring case and spaces', () => {
		const loose = flow('d', 'Delta', '  discovery ')
		expect(choosePick({ installed: [A], catalog: [loose], dismissed: [] })?.flow.id).toBe('d')
	})

	it('never picks an installed, dismissed or uncategorised flow', () => {
		expect(choosePick({ installed: [A, B], catalog: [A, B], dismissed: [] })).toBeNull()
		expect(choosePick({ installed: [A], catalog: [A, B], dismissed: ['b'] })).toBeNull()
		expect(
			choosePick({ installed: [A], catalog: [A, flow('e', 'Epsilon', null)], dismissed: [] }),
		).toBeNull()
		expect(
			choosePick({ installed: [flow('f', 'Zeta', null)], catalog: [A, B], dismissed: [] }),
		).toBeNull()
	})

	it('returns nothing when no category is shared, or nothing is installed', () => {
		expect(choosePick({ installed: [C], catalog: [A, B, C], dismissed: [] })).toBeNull()
		expect(choosePick({ installed: [], catalog: [A, B, C], dismissed: [] })).toBeNull()
	})

	it('is deterministic: the first match by slug', () => {
		const first = flow('g', 'Aardvark', 'Discovery')
		expect(choosePick({ installed: [A], catalog: [B, first, A], dismissed: [] })?.flow.id).toBe('g')
	})
})

describe('pickWeekOpen', () => {
	it('allows the first pick, and one again on the seventh day', () => {
		expect(pickWeekOpen(null, '2026-03-10')).toBe(true)
		expect(pickWeekOpen('2026-03-10', '2026-03-16')).toBe(false)
		expect(pickWeekOpen('2026-03-10', '2026-03-17')).toBe(true)
	})
})

describe('summary email with a pick', () => {
	const base = {
		summary: {
			title: '1 thing needs you',
			body: '1 thing needs you',
			waiting: 1,
			finished: 0,
			workspaceId: 'w',
			workspaceName: 'W',
			multiWorkspace: false,
			topObjectId: null,
			topHeadline: null,
			waitingElsewhere: 0,
			finishedRuns: [],
		},
		step: 'daily' as const,
		buttonUrl: 'https://maskin.test/w?surface=email&block=summary',
		stopUrl: 'https://maskin.test/api/email/stop?token=x',
		nextStep: null,
	}
	const pick = {
		name: 'Beta Watch',
		description: 'Watches the market <b>for you</b>.',
		why: 'you already use Alpha Watch, and this is another flow for Discovery.',
		url: 'https://maskin.test/w/marketplace/b?surface=email&block=pick',
		dismissUrl: 'https://maskin.test/api/email/pick-dismiss?token=y',
	}

	it('puts the pick below the summary button and above the stop link, in text and html', () => {
		const mail = buildSummaryEmail({ ...base, pick })
		const { text, html } = mail
		expect(text.indexOf('Open it:')).toBeLessThan(text.indexOf('Marketplace pick'))
		expect(text.indexOf('Marketplace pick')).toBeLessThan(text.indexOf('Stop these emails'))
		expect(text).toContain('Why you see this: you already use Alpha Watch')
		expect(text).toContain(`Not useful: ${pick.dismissUrl}`)
		expect(html).toContain('Not useful</a>')
		expect(html).toContain('&lt;b&gt;for you&lt;/b&gt;')
		expect(html).not.toContain('<b>for you</b>')
		expect(mail.subject).toBe('1 thing needs you')
	})

	it('has no pick block, no price talk and no urgency without one', () => {
		const { text } = buildSummaryEmail(base)
		expect(text).not.toContain('Marketplace')
		const withPick = buildSummaryEmail({ ...base, pick }).text.toLowerCase()
		for (const word of ['free', 'discount', 'limited', 'hurry', 'now!', 'upgrade', '$']) {
			expect(withPick).not.toContain(word)
		}
	})
})
