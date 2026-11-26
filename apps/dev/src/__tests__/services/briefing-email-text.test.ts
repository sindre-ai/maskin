import { describe, expect, it, vi } from 'vitest'
import {
	STEP_LESSON,
	buildSummaryEmail,
	digestPreheader,
	digestSubject,
	emailRole,
	pickNextStep,
} from '../../services/briefing-email-text'
import type { NextStepFacts } from '../../services/briefing-email-text'
import type {
	DigestData,
	DigestUpdateRow,
	DigestWaitingRow,
} from '../../services/digest-email-data'
import { MAIN_BUTTON } from '../../services/email-layout'

const NOW = new Date('2026-03-10T08:00:00Z')
const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00Z`)

const waitingRow = (over: Partial<DigestWaitingRow> = {}): DigestWaitingRow => ({
	workspaceId: 'w1',
	title: 'Approve the launch plan',
	line: 'Strategist needs your yes before Friday.',
	typeLabel: 'Bet',
	typeKind: 'bet',
	at: at('07:12'),
	dueAt: null,
	path: '/w1/objects/o1',
	buttonLabel: 'Review',
	...over,
})
const updateRow = (over: Partial<DigestUpdateRow> = {}): DigestUpdateRow => ({
	workspaceId: 'w1',
	title: 'Three customers ask for SSO',
	line: 'Strategist mentioned you',
	at: at('06:05'),
	path: '/w1/objects/o2',
	...over,
})
const digest = (over: Partial<DigestData> = {}): DigestData => ({
	waitingCount: 2,
	waiting: [
		waitingRow(),
		waitingRow({
			title: 'Which sender?',
			line: '2 new messages',
			typeLabel: 'Chat',
			typeKind: 'chat',
			path: '/w1/chats/c1',
			buttonLabel: 'Reply',
		}),
	],
	groups: [
		{ kind: 'objects', count: 2, rows: [updateRow(), updateRow({ title: 'Pick a sender' })] },
		{
			kind: 'flows',
			count: 1,
			rows: [updateRow({ title: 'Weekly digest', line: 'Finished a run', path: '/w1/loops/f1' })],
		},
		{
			kind: 'chats',
			count: 1,
			rows: [updateRow({ title: 'Design Studio', line: '1 new message', path: '/w1/chats/c2' })],
		},
	],
	updatesCount: 4,
	anchorWorkspaceId: 'w1',
	...over,
})
const input = (over: Record<string, unknown> = {}) => ({
	digest: digest(),
	step: 'daily' as const,
	appUrl: 'https://maskin.test',
	timezone: 'UTC',
	now: NOW,
	sendTime: '07:30',
	rhythm: null,
	buttonUrl: 'https://maskin.test/w1?surface=email&block=summary',
	stopUrl: 'https://maskin.test/api/email/stop?token=abc',
	nextStep: null,
	...over,
})

describe('digestSubject', () => {
	it('covers both parts, only updates and only waiting items', () => {
		expect(digestSubject(2, 5)).toBe('2 need you, 5 other updates')
		expect(digestSubject(1, 1)).toBe('1 needs you, 1 other update')
		expect(digestSubject(0, 5)).toBe('5 updates')
		expect(digestSubject(0, 1)).toBe('1 update')
		expect(digestSubject(2, 0)).toBe('2 need you')
		expect(digestSubject(1, 0)).toBe('1 needs you')
	})
})

describe('buildSummaryEmail', () => {
	it('has the split subject, the two parts, one Open Maskin button and the stop link', () => {
		const mail = buildSummaryEmail(input())
		expect(mail.subject).toBe('2 need you, 4 other updates')
		expect(mail.text).toContain('Needs you (2)')
		expect(mail.text).toContain('Updates (4)')
		expect(mail.text).toContain('Objects (2)')
		expect(mail.text).toContain('Flows (1)')
		expect(mail.text).toContain('Chats (1)')
		expect(mail.text).toContain('Open Maskin: https://maskin.test/w1?surface=email&block=summary')
		expect(mail.text).toContain('Stop these emails: https://maskin.test/api/email/stop?token=abc')
		expect(mail.html).toContain('<h1')
		expect(mail.html.match(/>Open Maskin</g)).toHaveLength(1)
		expect(mail.html).toContain('Stop these emails')
		// The old body is gone.
		for (const old of ['Done for you', 'Waiting on you', 'things need you', 'Open it']) {
			expect(mail.text).not.toContain(old)
			expect(mail.html).not.toContain(old)
		}
	})

	it('sets the one-click unsubscribe headers to the stop link', () => {
		const { headers } = buildSummaryEmail(input())
		expect(headers['List-Unsubscribe']).toBe('<https://maskin.test/api/email/stop?token=abc>')
		expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
	})

	it('gives each waiting item its own button: Review for a card, Reply for a chat, both tagged as email', () => {
		const { html, text } = buildSummaryEmail(input())
		expect(html).toContain('>Review</a>')
		expect(html).toContain('>Reply</a>')
		expect(html).toContain(
			'href="https://maskin.test/w1/objects/o1?surface=email&amp;block=waiting"',
		)
		expect(html).toContain('href="https://maskin.test/w1/chats/c1?surface=email&amp;block=waiting"')
		expect(text).toContain('Reply: https://maskin.test/w1/chats/c1?surface=email&block=waiting')
		// Update rows link to their object, flow or chat and have no button.
		expect(html).toContain('href="https://maskin.test/w1/loops/f1?surface=email&amp;block=updates"')
		expect(html).toContain('href="https://maskin.test/w1/chats/c2?surface=email&amp;block=updates"')
	})

	it('shows a due time before an asked time, with the type label', () => {
		const { text } = buildSummaryEmail(
			input({
				digest: digest({
					waiting: [waitingRow({ dueAt: new Date('2026-03-11T10:00:00Z') }), waitingRow()],
				}),
			}),
		)
		expect(text).toContain('[Bet, Due Wed 10:00]')
		expect(text).toContain('[Bet, Asked 07:12]')
	})

	it('folds the waiting items past the shown ones into one link', () => {
		const { text, html } = buildSummaryEmail(input({ digest: digest({ waitingCount: 20 }) }))
		expect(text).toContain('18 more waiting for you in Maskin')
		expect(html).toContain('18 more waiting for you in Maskin')
		expect(buildSummaryEmail(input()).text).not.toContain('more waiting')
	})

	it('folds a group past its five rows into "N more in Maskin"', () => {
		const rows = Array.from({ length: 5 }, (_, i) => updateRow({ title: `Row ${i}` }))
		const { text } = buildSummaryEmail(
			input({
				digest: digest({
					groups: [{ kind: 'objects', count: 9, rows }],
					updatesCount: 9,
				}),
			}),
		)
		expect(text).toContain('Objects (9)')
		expect(text).toContain('4 more in Maskin')
		expect(text).toContain('Updates (9)')
	})

	it('leaves Needs you out when nothing waits, and Updates out when there are none', () => {
		const updatesOnly = buildSummaryEmail(
			input({ digest: digest({ waitingCount: 0, waiting: [] }) }),
		)
		expect(updatesOnly.subject).toBe('4 updates')
		expect(updatesOnly.text).not.toContain('Needs you')
		expect(updatesOnly.html).not.toContain('Needs you')

		const waitingOnly = buildSummaryEmail(
			input({ digest: digest({ groups: [], updatesCount: 0 }) }),
		)
		expect(waitingOnly.subject).toBe('2 need you')
		expect(waitingOnly.text).not.toContain('Updates')
		expect(waitingOnly.html).not.toContain('Updates')
	})

	it('leaves a group out when it has no rows', () => {
		const { text } = buildSummaryEmail(
			input({
				digest: digest({
					groups: [{ kind: 'chats', count: 1, rows: [updateRow({ title: 'Design Studio' })] }],
					updatesCount: 1,
				}),
			}),
		)
		expect(text).toContain('Chats (1)')
		expect(text).not.toContain('Objects')
		expect(text).not.toContain('Flows')
	})

	it('gives steps 1, 2 and 3 their own lesson, below the list and above the button', () => {
		for (const step of [1, 2, 3] as const) {
			const { text, html } = buildSummaryEmail(
				input({ step, nextStep: 'Open the card at the top first.' }),
			)
			expect(text).toContain(STEP_LESSON[step])
			expect(html).toContain(STEP_LESSON[step].slice(0, 30))
			expect(text.indexOf('Chats (1)')).toBeLessThan(text.indexOf('Next step'))
			expect(text.indexOf('Next step')).toBeLessThan(text.indexOf(STEP_LESSON[step]))
			expect(text.indexOf(STEP_LESSON[step])).toBeLessThan(text.indexOf('Open Maskin:'))
		}
		const daily = buildSummaryEmail(input()).text
		for (const lesson of Object.values(STEP_LESSON)) expect(daily).not.toContain(lesson)
	})

	it('names the send time and says one email a day, or a week', () => {
		expect(buildSummaryEmail(input()).text).toContain(
			'One email a day instead of one per notification. It lists what is still unread when it goes out, at 07:30.',
		)
		expect(buildSummaryEmail(input({ rhythm: 'weekly' })).html).toContain('One email a week')
	})

	it("prints times in the person's timezone", () => {
		const { text } = buildSummaryEmail(input({ timezone: 'Europe/Copenhagen' }))
		expect(text).toContain('Asked 08:12') // 07:12 UTC is 08:12 in Copenhagen in March
	})

	it('has a hidden preview that leads with the first waiting item and counts the rest', () => {
		expect(digestPreheader(digest())).toBe('Approve the launch plan, and 5 more unread.')
		expect(digestPreheader(digest({ waitingCount: 0, waiting: [] }))).toBe(
			'Three customers ask for SSO, and 3 more unread.',
		)
		expect(
			digestPreheader(
				digest({ groups: [], updatesCount: 0, waitingCount: 1, waiting: [waitingRow()] }),
			),
		).toBe('Approve the launch plan')
		const { html } = buildSummaryEmail(input())
		expect(html).toContain('Approve the launch plan, and 5 more unread.')
	})

	it('escapes text that came from a card, a chat or an object', () => {
		const { html } = buildSummaryEmail(
			input({
				digest: digest({
					waiting: [waitingRow({ title: '<script>alert(1)</script>', line: '<b>x</b>' })],
				}),
			}),
		)
		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html).not.toContain('<b>x</b>')
		expect(html).toContain('&lt;script&gt;')
	})

	it('takes the button colour from the one place MAIN_BUTTON', () => {
		const { html } = buildSummaryEmail(input())
		expect(html).toContain(`bgcolor="${MAIN_BUTTON.bg}"`)
		expect(html).toContain(MAIN_BUTTON.darkBg)
	})

	it('carries a next-step line when there is one, and none when there is not', () => {
		expect(
			buildSummaryEmail(input({ nextStep: 'Open the card at the top first.' })).text,
		).toContain('Next step\n- Open the card at the top first.')
		expect(buildSummaryEmail(input()).text).not.toContain('Next step')
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
