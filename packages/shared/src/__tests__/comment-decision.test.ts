import { describe, expect, it } from 'vitest'
import {
	type CommentDecision,
	commentDecisionSchema,
	validateDecisionProse,
} from '../schemas/comment-decision'
import { createCommentSchema } from '../schemas/events'

function buildDecision(overrides: Partial<CommentDecision> = {}): CommentDecision {
	return {
		title: 'Is the onboarding bet worth running?',
		summary:
			'3 of 5 signups stall on step 2, costing about 40 activations a week. I have drafted the replacement copy.',
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
		...overrides,
	}
}

/** Every violation quotes its own field, so tests assert on the pair. */
function violate(decision: CommentDecision) {
	return validateDecisionProse(decision).map((violation) => violation.path)
}

describe('commentDecisionSchema', () => {
	it('accepts a well-formed decision', () => {
		expect(commentDecisionSchema.safeParse(buildDecision()).success).toBe(true)
		expect(validateDecisionProse(buildDecision())).toEqual([])
	})

	it('rejects fewer than 2 or more than 3 options at the schema layer', () => {
		const one = buildDecision({ options: buildDecision().options.slice(0, 1) })
		expect(commentDecisionSchema.safeParse(one).success).toBe(false)

		const four = buildDecision({
			options: Array.from({ length: 4 }, (_, index) => ({
				label: `Option ${index}`,
				consequences: ['Ships today', 'Costs a week'],
			})),
		})
		expect(commentDecisionSchema.safeParse(four).success).toBe(false)
	})

	it('rejects an option with fewer than 2 consequence lines', () => {
		const decision = buildDecision({
			options: [
				{ label: 'Hold', recommended: true, consequences: ['Nothing ships'] },
				{ label: 'Ship', consequences: ['Goes out today', 'No rollback'] },
			],
		})
		expect(commentDecisionSchema.safeParse(decision).success).toBe(false)
	})
})

describe('validateDecisionProse', () => {
	it('rejects a title outside 3-7 words, naming the count', () => {
		const [violation] = validateDecisionProse(buildDecision({ title: 'Onboarding' }))
		expect(violation?.path).toBe('title')
		expect(violation?.message).toContain('got 1')
		expect(violation?.message).toContain('"Onboarding"')

		expect(
			violate(
				buildDecision({ title: 'Should we consider whether the onboarding bet is worth it' }),
			),
		).toContain('title')
	})

	it('rejects a title that opens with a verb-ing status', () => {
		const violations = validateDecisionProse(
			buildDecision({ title: 'Reviewing the onboarding bet' }),
		)
		expect(violations.some((v) => v.path === 'title' && v.message.includes('status'))).toBe(true)
	})

	it('allows a short -ing word that is not a status verb', () => {
		expect(violate(buildDecision({ title: 'Ring the vendor today' }))).not.toContain('title')
	})

	it('rejects a summary longer than 2 sentences', () => {
		const decision = buildDecision({
			summary: 'Step 2 loses 40 a week. I drafted the copy. I also wrote the migration.',
		})
		const violations = validateDecisionProse(decision)
		expect(violations.some((v) => v.path === 'summary' && v.message.includes('got 3'))).toBe(true)
	})

	it('rejects a summary with no concrete number', () => {
		const decision = buildDecision({
			summary: 'Most signups stall on step two. I have drafted the replacement copy.',
		})
		expect(
			validateDecisionProse(decision).some(
				(v) => v.path === 'summary' && v.message.includes('no digits'),
			),
		).toBe(true)
	})

	it('rejects a summary that restates the title', () => {
		const decision = buildDecision({
			title: 'Is the onboarding bet worth running?',
			summary: 'The onboarding bet may be worth running, on 3 signals.',
		})
		expect(
			validateDecisionProse(decision).some(
				(v) => v.path === 'summary' && v.message.includes('restates the title'),
			),
		).toBe(true)
	})

	it('rejects an ask that is not one first-person sentence', () => {
		expect(violate(buildDecision({ ask: 'Approval is needed before this ships.' }))).toContain(
			'ask',
		)
		expect(
			validateDecisionProse(buildDecision({ ask: 'I need a call. I cannot make it alone.' })).some(
				(v) => v.path === 'ask' && v.message.includes('one sentence'),
			),
		).toBe(true)
	})

	it('requires exactly one recommended option', () => {
		const none = buildDecision({
			options: buildDecision().options.map((option) => ({ ...option, recommended: false })),
		})
		expect(
			validateDecisionProse(none).some((v) => v.path === 'options' && v.message.includes('got 0')),
		).toBe(true)

		const both = buildDecision({
			options: buildDecision().options.map((option) => ({ ...option, recommended: true })),
		})
		expect(
			validateDecisionProse(both).some((v) => v.path === 'options' && v.message.includes('got 2')),
		).toBe(true)
	})

	it('rejects an option label over 4 words', () => {
		const decision = buildDecision({
			options: [
				{
					label: 'Ship it in a seven day window',
					recommended: true,
					consequences: ['Ships tomorrow', 'Adds 18 tickets'],
				},
				{ label: 'Hold', consequences: ['Nothing ships', 'Costs 40 a week'] },
			],
		})
		expect(violate(decision)).toContain('options.0.label')
	})

	it('rejects a consequence carrying more than one clause', () => {
		const decision = buildDecision({
			options: [
				{
					label: 'Ship',
					recommended: true,
					consequences: ['Ships tomorrow, and adds 18 tickets', 'Costs nothing'],
				},
				{ label: 'Hold', consequences: ['Nothing ships', 'Costs 40 a week'] },
			],
		})
		expect(violate(decision)).toContain('options.0.consequences.0')
	})

	it('rejects em-dashes, emoji and hedge words anywhere in the block', () => {
		expect(violate(buildDecision({ ask: 'I will not ship this — it needs a person.' }))).toContain(
			'ask',
		)
		expect(violate(buildDecision({ ask: 'I will not ship this alone 🚀' }))).toContain('ask')
		expect(
			validateDecisionProse(
				buildDecision({
					summary: 'Step 2 costs us significantly more than 3 others. I drafted the copy.',
				}),
			).some((v) => v.path === 'summary' && v.message.includes('significantly')),
		).toBe(true)
	})

	// The whole point of the hard-reject design: one retry has to be enough, so
	// a decision that breaks several rules reports all of them at once.
	it('reports every violation rather than stopping at the first', () => {
		const decision = buildDecision({
			title: 'Reviewing',
			summary: 'It is quite bad — really.',
			ask: 'Approval is needed.',
		})
		const paths = violate(decision)
		expect(new Set(paths)).toEqual(new Set(['title', 'summary', 'ask']))
		expect(paths.length).toBeGreaterThan(3)
	})
})

describe('create_comment agent-facing docs', () => {
	// The descriptions are the enforcement mechanism: the MCP SDK turns them
	// into the tool's JSON Schema property docs, which is where an agent reads
	// the format. Losing them would silently remove the spec.
	it('carries the decision format on the schema an agent reads', () => {
		const decision = createCommentSchema.shape.decision
		expect(decision.description).toContain('For You')
		expect(decision.description).toContain('mentions')

		const shape = commentDecisionSchema.shape
		expect(shape.title.description).toContain('3-7 words')
		expect(shape.summary.description).toContain('Never restate the title')
		expect(shape.ask.description).toContain('First person')
		expect(shape.options.description).toContain('exactly one marked recommended')
	})
})
