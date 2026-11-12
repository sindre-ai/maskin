import { describe, expect, it } from 'vitest'
import { buildSendBackNudge, detectWorkLeft } from '../../lib/work-left'

describe('detectWorkLeft', () => {
	describe('endings that are sent back', () => {
		it('flags "Next I\'ll..." with nothing started, with or without tool calls', () => {
			// The Prospector ending, 11 Nov: one step done, then this and stop.
			const m = detectWorkLeft(
				"Six companies are scored. Next I'll run those phone lookups and then source people.",
			)
			expect(m).toEqual({ kind: 'next_step_announced', needsToolCalls: false })
		})

		it('flags "Next step: I\'ll start a session..." (a real closing line from 30 Oct)', () => {
			const m = detectWorkLeft(
				"Nobody has picked up either red check. That's on me.\n\nNext step: I'll start a session to read both failures and push fixes to the PR branch.",
			)
			expect(m?.kind).toBe('next_step_announced')
		})

		it('flags a permission question about a step that sends nothing', () => {
			// The Prospector ending, 11 Nov, as the task quotes it.
			const m = detectWorkLeft(
				'I found six companies. Do you want me to go ahead and score them and find contacts?',
			)
			expect(m).toEqual({ kind: 'permission_question', needsToolCalls: true })
		})

		it('flags an offer of more work as a closing line', () => {
			const m = detectWorkLeft('I updated the bet. Say if you want me to look at anything else.')
			expect(m).toEqual({ kind: 'offer_more', needsToolCalls: true })
		})

		it('flags "let me know if" and "what should I start on next"', () => {
			expect(detectWorkLeft('Done with the audit. Let me know if you need more.')?.kind).toBe(
				'offer_more',
			)
			expect(detectWorkLeft('The task is closed. What should I start on next?')?.kind).toBe(
				'offer_more',
			)
		})

		it('flags "nothing is scheduled" and "I haven\'t started"', () => {
			expect(detectWorkLeft('Nothing is scheduled for the webinar yet.')?.kind).toBe(
				'nothing_scheduled',
			)
			expect(detectWorkLeft("I haven't started on the invites.")?.kind).toBe('nothing_scheduled')
		})

		it('reads only the end of a long reply', () => {
			const long = `${'The audit found nothing unusual. '.repeat(60)}Next I will draft the follow-up list.`
			expect(detectWorkLeft(long)?.kind).toBe('next_step_announced')
			const early = `Next I will draft the follow-up list.${' All of it is done and merged.'.repeat(40)}`
			expect(detectWorkLeft(early)).toBeNull()
		})
	})

	describe('endings that are let through', () => {
		it.each([
			["sends in a person's name", 'Do you want me to send the email to Hans now?'],
			['posts publicly', 'Want me to publish the post on LinkedIn?'],
			['deletes', 'Should I delete the old branch?'],
			['spends', 'Shall I buy the extra seats?'],
		])('lets a permission question through when the step %s', (_name, text) => {
			expect(detectWorkLeft(text)).toBeNull()
		})

		it('does not treat the noun "contacts" as a step that contacts someone', () => {
			expect(detectWorkLeft('Do you want me to go ahead and find contacts?')?.kind).toBe(
				'permission_question',
			)
		})

		it('lets through a reply that says what it waits on or that a wake-up is set', () => {
			expect(
				detectWorkLeft("I've scheduled a check for tomorrow morning. Next I'll read the result."),
			).toBeNull()
			expect(
				detectWorkLeft("Waiting on the build. Next I'll open the PR once the build finishes."),
			).toBeNull()
		})

		it('lets through a question that needs information only a person has', () => {
			expect(detectWorkLeft('Which of the two names do you prefer?')).toBeNull()
			expect(detectWorkLeft('What is the budget for this campaign?')).toBeNull()
		})

		// Closing lines of real Developer replies in chats on 29 Oct to 11 Nov. None needs a send-back.
		it.each([
			"Moving the new bet from opportunity to define is Strategist's step once you sign off.",
			"Strategist will reply here once the bet exists. I haven't built anything for this yet.",
			'If you say yes, the task moves to todo and I start with a server test of a 50 MB video.',
			"Once the bet and its tasks exist, I'll build them.",
			'Do you want to start that bet, or leave it to the Strategist?',
			'Next step: the Code Reviewer re-reviews, then the CTO merges.',
			"Next step: nothing from you. I'll report when either session finishes.",
			'Next step: run the TestFlight check and tell me what breaks. I\'d do typo tolerance next, since "mgnus" finding Magnus is the gap you\'d notice first.',
			'Tell me if you meant a different name.',
			'Nothing for you to do.',
			'Test efter udrulning: skriv til hinanden i en direkte chat og tjek, at push kommer frem.',
		])('does not flag the real closing line: %s', (text) => {
			const m = detectWorkLeft(text)
			// "I haven't built anything" is a status line, not "haven't started": it must not match.
			expect(m).toBeNull()
		})

		it('returns null for an empty reply', () => {
			expect(detectWorkLeft('   ')).toBeNull()
		})
	})
})

describe('buildSendBackNudge', () => {
	it('names the ending, the exits, and is addressed to the model', () => {
		const text = buildSendBackNudge('permission_question')
		expect(text.startsWith('[system correction]')).toBe(true)
		expect(text).toContain('asked permission')
		expect(text).toContain('sends something in their name, spends money, deletes')
		expect(text).toContain('set a wake-up')
	})

	it('has a distinct reason for each ending', () => {
		const reasons = (
			['next_step_announced', 'permission_question', 'offer_more', 'nothing_scheduled'] as const
		).map(buildSendBackNudge)
		expect(new Set(reasons).size).toBe(4)
	})
})
