import { decisionOfEvent, hasDecision, legacyChipsOf } from '@/lib/comment-decision'
import { describe, expect, it } from 'vitest'
import { buildEventResponse } from '../factories'

// A block that satisfies every rule in `commentDecisionSchema`, so the tests
// below vary one thing at a time against a known-good baseline.
const validDecision = {
	title: 'Is the onboarding bet worth running?',
	summary: '3 of 5 signups stall on step 2. I have drafted the replacement copy.',
	ask: 'This changes what every new customer sees first, so I will not ship it alone.',
	options: [
		{
			label: '7-day window',
			recommended: true,
			consequences: ['Ships with cycle 1 tomorrow', 'Adds 18 support tickets in week one'],
		},
		{
			label: 'Hold',
			consequences: ['Nothing ships this cycle', 'Keeps losing 40 activations a week'],
		},
	],
}

function commentWith(data: Record<string, unknown>) {
	return buildEventResponse({ id: 42, action: 'commented', data })
}

describe('decisionOfEvent', () => {
	it('returns the parsed decision when the comment carries a valid block', () => {
		expect(decisionOfEvent(commentWith({ decision: validDecision }))?.title).toBe(
			validDecision.title,
		)
	})

	it('returns null for an event that is not a comment', () => {
		const event = buildEventResponse({ action: 'updated', data: { decision: validDecision } })
		expect(decisionOfEvent(event)).toBeNull()
	})

	it('returns null when the comment has no decision', () => {
		expect(decisionOfEvent(commentWith({ content: 'Just a comment' }))).toBeNull()
	})

	it('returns null when data is absent entirely', () => {
		expect(decisionOfEvent(buildEventResponse({ action: 'commented', data: null }))).toBeNull()
	})

	// The three shapes that a bare `typeof x === 'object'` check let through.
	// Each one used to read as a decision on the timeline while the For You feed,
	// which parsed properly, showed a plain thread card.
	it.each([
		['null', null],
		['an empty object', {}],
		['an array', []],
		['a string', 'ship it'],
		['a partial block missing options', { title: 'Pick one', summary: 'x', ask: 'y' }],
	])('returns null when the decision is %s', (_label, decision) => {
		expect(decisionOfEvent(commentWith({ decision }))).toBeNull()
	})
})

describe('hasDecision', () => {
	it('is true only when a decision parses', () => {
		expect(hasDecision(commentWith({ decision: validDecision }))).toBe(true)
		expect(hasDecision(commentWith({ decision: {} }))).toBe(false)
		expect(hasDecision(commentWith({ content: 'no ask here' }))).toBe(false)
	})

	// The mechanism `decision` replaced. A stored chip comment is a plain
	// comment now, on every surface that asks this question.
	it('is false for a comment carrying only legacy metadata.chips', () => {
		const event = commentWith({ content: 'Pick one', metadata: { chips: ['ship', 'wait'] } })
		expect(hasDecision(event)).toBe(false)
	})
})

describe('legacyChipsOf', () => {
	it('reads the labels of a pre-decision comment so they stay legible', () => {
		const event = commentWith({
			content: 'Pick one',
			metadata: { chips: ['ship', 'wait', 'kill'] },
		})
		expect(legacyChipsOf(event)).toEqual(['ship', 'wait', 'kill'])
	})

	it('returns an empty list when there are no chips', () => {
		expect(legacyChipsOf(commentWith({ content: 'Plain' }))).toEqual([])
		expect(legacyChipsOf(commentWith({ metadata: {} }))).toEqual([])
		expect(legacyChipsOf(commentWith({ metadata: { chips: [] } }))).toEqual([])
	})

	it('drops non-string and blank entries rather than rendering holes', () => {
		const event = commentWith({ metadata: { chips: ['ship', '', '  ', 7, null, 'wait'] } })
		expect(legacyChipsOf(event)).toEqual(['ship', 'wait'])
	})

	it('ignores metadata that is not an object', () => {
		expect(legacyChipsOf(commentWith({ metadata: ['chips'] }))).toEqual([])
		expect(legacyChipsOf(commentWith({ metadata: 'chips' }))).toEqual([])
	})

	it('returns an empty list for an event that is not a comment', () => {
		const event = buildEventResponse({ action: 'updated', data: { metadata: { chips: ['a'] } } })
		expect(legacyChipsOf(event)).toEqual([])
	})
})
