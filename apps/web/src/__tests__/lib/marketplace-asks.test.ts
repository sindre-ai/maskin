import { stepAsksYou } from '@/lib/marketplace-asks'
import { describe, expect, it } from 'vitest'

describe('stepAsksYou', () => {
	it('returns null for an empty or missing prompt', () => {
		expect(stepAsksYou('')).toBeNull()
		expect(stepAsksYou('   ')).toBeNull()
	})

	it('returns null when the prompt only mentions approval in passing', () => {
		// These must NOT trip the classifier — a passing mention is not a gate.
		const autonomous =
			'You are the Developer. You implement on the bet branch. You never merge — the Code Reviewer owns the merge. Once the Code Reviewer approves, you ship.'
		expect(stepAsksYou(autonomous)).toBeNull()
	})

	it('flags a step that requires explicit sign-off', () => {
		const ask = stepAsksYou(
			'You draft a recommendation and post it for the operator. Never auto-apply; you require explicit user signoff before the change lands.',
		)
		expect(ask).not.toBeNull()
		expect(ask?.ask).toBe('your explicit sign-off')
		expect(ask?.reason).toContain('explicit user signoff')
	})

	it('flags a step that waits for the operator to approve', () => {
		const ask = stepAsksYou(
			`Output a proposal and wait for the operator's approval before proceeding. Do not push past the gate.`,
		)
		expect(ask).not.toBeNull()
		expect(ask?.ask).toBe('your approval')
		expect(ask?.reason).toContain("operator's approval")
	})

	it('flags a step whose skill never auto-applies', () => {
		const ask = stepAsksYou(
			'The Commitment is a proposal. A human approves; it is never auto-created. Sequence: draft, post, stop.',
		)
		expect(ask).not.toBeNull()
		expect(ask?.ask).toBe('an explicit go-ahead')
	})

	it('flags a step that asks the operator to confirm', () => {
		const ask = stepAsksYou('When you hit a risk, asks you to confirm before escalating.')
		expect(ask).not.toBeNull()
		expect(ask?.ask).toBe('a decision from you')
	})

	it('flags a negated "without your approval" gate', () => {
		for (const prompt of [
			'You prepare the merge, but it never lands without your approval.',
			'You open the PR. You do not merge without a human sign-off.',
			"Nothing ships without the operator's go-ahead.",
		]) {
			const ask = stepAsksYou(prompt)
			expect(ask, prompt).not.toBeNull()
			expect(ask?.ask).toBe('your approval')
		}
	})

	it('does NOT flag a bare "without your approval" autonomy claim', () => {
		// The inverse of the gate above: these say the step proceeds on its own.
		// Matching them would put an "asks you" pill on a step that never pauses.
		for (const prompt of [
			'Once CI is green you merge without your approval and post the result.',
			'This runs without a human sign-off -- no human approval needed.',
			"The agent proceeds without the operator's go-ahead.",
		]) {
			expect(stepAsksYou(prompt), prompt).toBeNull()
		}
	})

	it('keeps the reason as a trimmed, bounded excerpt of the real prompt', () => {
		const ask = stepAsksYou(`First line. ${'x'.repeat(400)} Only here sign-off is required. More.`)
		expect(ask).not.toBeNull()
		expect(ask?.reason.length).toBeLessThan(300)
		expect(ask?.reason).toContain('sign-off is required')
	})
})
